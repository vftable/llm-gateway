import {
  OpenAICompatibleAdapter,
  type UsageCtx,
  type KeyUsageResult,
} from "../base";
import {
  WireKind,
  type Provider,
  type ProviderKeyUsageWindow,
} from "../../types";
import type {
  AnyRequestTransform,
  AnyResponseTransform,
  AnyStreamTransform,
} from "../../formats/pipeline";
import { onRequest, onResponse, onStreamEvent } from "../../formats/pipeline";
import type { ChatCompletionChunk } from "../../formats/wire/openai-chat";

// Mistral - OpenAI-compatible chat API at https://api.mistral.ai/v1, with a
// STRICT body schema: `additionalProperties: false` on ChatCompletionRequest
// and on every message variant. Fields OpenAI/Anthropic clients add freely are
// hard 422s:
//   - prompt_cache_retention (Responses-API only; chat accepts only
//     prompt_cache_key), store, user, gateway-internal `_`-prefixed fields
//   - max_completion_tokens / seed -> max_tokens / random_seed renames
//   - temperature capped at 1.5
//   - messages carry only role-legal fields: assistant has NO reasoning_content
//     (nor reasoning/reasoning_details/name), system/user have content only.
// The mistral:compat request transform scrubs all of that post-conversion.
// Mistral therefore declares NO openai-cache family default (it would 422).

// Chat completion fields Mistral accepts, by role (OpenAPI: additionalProperties
// false on SystemMessage/UserMessage/AssistantMessage/ToolMessage).
const MESSAGE_FIELDS: Record<string, readonly string[]> = {
  system: ["role", "content"],
  user: ["role", "content"],
  tool: ["role", "content", "tool_call_id", "name"],
  assistant: ["role", "content", "tool_calls", "prefix"],
};

// Fields Mistral rejects at the request top level (verified against its
// OpenAPI spec) - dropped outright.
const STRIP_BODY_FIELDS = ["prompt_cache_retention", "store", "user"];

// gateway-internal markers consumed by other providers' defaults; useless here.
const STRIP_INTERNAL_FIELDS = ["_reasoning_summary", "_thinking_disabled"];

// OpenAI-era names Mistral spells differently.
const RENAME_BODY_FIELDS: Array<[from: string, to: string]> = [
  ["max_completion_tokens", "max_tokens"],
  ["seed", "random_seed"],
];

const MAX_TEMPERATURE = 1.5;

function pick(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in source) out[key] = source[key];
  }
  return out;
}

// Trim one message to its role-legal fields. Unknown roles pass through
// untouched (only Mistral's four known roles are constrained).
function scrubMessage(m: unknown): unknown {
  if (!m || typeof m !== "object" || Array.isArray(m)) return m;
  const msg = m as Record<string, unknown>;
  const legal = MESSAGE_FIELDS[msg.role as string];
  if (!legal) return msg;
  const scrubbed = pick(msg, legal);
  // Mistral requires `content` on every message variant.
  if (scrubbed.content === undefined) scrubbed.content = "";
  if (Array.isArray(scrubbed.tool_calls)) {
    scrubbed.tool_calls = scrubbed.tool_calls.map((tc) => {
      if (!tc || typeof tc !== "object") return tc;
      const call = tc as Record<string, unknown>;
      const out = pick(call, ["id", "type", "function", "index"]);
      if (call.function && typeof call.function === "object") {
        out.function = pick(call.function, ["name", "arguments"]);
      }
      return out;
    });
  }
  return scrubbed;
}

// Drop OpenAI-platform fields Mistral's strict schema rejects, rename the ones
// it spells differently, clamp the temperature, and strip each message down to
// its role-legal fields.
function scrubForMistral(body: Record<string, unknown>): unknown {
  for (const field of [...STRIP_BODY_FIELDS, ...STRIP_INTERNAL_FIELDS]) {
    delete body[field];
  }
  for (const [from, to] of RENAME_BODY_FIELDS) {
    if (body[from] !== undefined && body[to] === undefined) body[to] = body[from];
    delete body[from];
  }
  if (
    typeof body.temperature === "number" &&
    body.temperature > MAX_TEMPERATURE
  ) {
    body.temperature = MAX_TEMPERATURE;
  }
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map(scrubMessage);
  }
  return body;
}

// --- response-side thinking lift -------------------------------------------

// Mistral ships a model's reasoning INSIDE `content` as typed chunks -
// content: [{ type: "thinking", thinking: [{ type: "text", text: … }] }]
// (verified live on deepseek-v4-1-flash-1017) - where OpenAI-style clients
// expect a `reasoning_content` sibling the gateway's chat<->messages/
// responses bridges already translate into Anthropic thinking blocks. The two
// stages below lift the thinking text back into those fields.
//
// ThinkChunk.signature (Mistral replay data) is dropped: downstream bridges
// synthesize their own signature anyway, and no client can consume Mistral's.

interface ThinkingSplit {
  /** Concatenated text of every `type:"thinking"` part ("" if none). */
  thinkingText: string;
  /** The non-thinking parts (empty array when content was all thinking). */
  rest: unknown[];
}

function splitThinkingParts(parts: unknown[]): ThinkingSplit {
  const chunks: string[] = [];
  const rest: unknown[] = [];
  for (const part of parts) {
    const thinking = partThinkingText(part);
    if (thinking) chunks.push(thinking);
    else rest.push(part);
  }
  return { thinkingText: chunks.join(""), rest };
}

// The text of one ContentChunk, or null when the part isn't a thinking chunk.
function partThinkingText(part: unknown): string | null {
  if (!part || typeof part !== "object") return null;
  const p = part as Record<string, unknown>;
  if (p.type !== "thinking") return null;
  const inner = p.thinking;
  if (!Array.isArray(inner)) return null;
  return inner
    .map(
      (t) =>
        (t &&
          typeof t === "object" &&
          typeof (t as Record<string, unknown>).text === "string" &&
          ((t as Record<string, unknown>).text as string)) ||
        "",
    )
    .join("");
}

// Lift thinking text out of one message/delta whose `content` may be a string,
// null, or a ContentChunk[]. Mutates `target` in place: sets
// `reasoning_content` (+ `reasoning_details` for buffered responses -
// the chat->responses converter reads only that shape) and rewrites `content`
// to the remaining parts, or "" when everything was thinking. A no-op for
// string/null content and when no thinking chunk is present.
function liftThinking(
  target: Record<string, unknown>,
  opts: { details?: boolean } = {},
): void {
  if (!Array.isArray(target.content)) return;
  const { thinkingText, rest } = splitThinkingParts(target.content);
  if (!thinkingText) return;
  target.reasoning_content =
    typeof target.reasoning_content === "string"
      ? target.reasoning_content + thinkingText
      : thinkingText;
  if (opts.details) {
    target.reasoning_details = [
      { type: "reasoning.text", text: thinkingText },
    ];
  }
  target.content = rest.length ? rest : "";
}

// Streaming-chunk view of what liftThinking touches.
type StreamChunk = ChatCompletionChunk;

// Rewrite one chat completion chunk's deltas in place. Never drops the chunk.
function liftThinkingInStreamChunk(chunk: StreamChunk): StreamChunk {
  for (const choice of chunk?.choices ?? []) {
    const delta = (choice as { delta?: Record<string, unknown> }).delta;
    if (delta) liftThinking(delta);
  }
  return chunk;
}

// Rewrite a buffered chat completion response in place (`details` on - the
// buffered chat->responses converter reads reasoning_details, not
// reasoning_content, so both fields get set).
function liftThinkingInResponse(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices)) return body;
  for (const choice of choices) {
    const msg = (choice as { message?: Record<string, unknown> }).message;
    if (msg) liftThinking(msg, { details: true });
  }
  return body;
}


class MistralAdapter extends OpenAICompatibleAdapter {
  override requestTransforms(_p: Provider): AnyRequestTransform[] {
    return [
      onRequest(
        "chat",
        "mistral:compat",
        (body) =>
          scrubForMistral(
            body as unknown as Record<string, unknown>,
          ) as never,
        { label: "Mistral request compat", group: "Mistral" },
      ),
    ];
  }

  // Lift Mistral's thinking content chunks into the OpenAI-style
  // reasoning_content / reasoning_details fields the wire bridges consume.
  override responseTransforms(_p: Provider): AnyResponseTransform[] {
    return [
      onResponse("chat", "mistral:thinking", (body) => {
        liftThinkingInResponse(body);
        return body as never;
      }),
    ];
  }

  override streamTransforms(_p: Provider): AnyStreamTransform[] {
    return [
      onStreamEvent("chat", "mistral:thinking-stream", (chunk) =>
        liftThinkingInStreamChunk(chunk),
      ),
    ];
  }
 
  // --- usage -----------------------------------------------------------------
  override supportsKeyUsage(_ctx: UsageCtx): boolean {
    return true;
  }

  // Mistral's billing API answers STANDARD API keys - no Enterprise admin key
  // needed (verified live on FREE/EDU keys):
  //   GET /v1/billing/budget (x-api-key) ->
  //     { vibe_budget: {usage_percentage, initial_budget, currency, reset_at,
  //                     payg_enabled}, api_budget: {…} }
  // Window selection by key metadata kind: tagged kind=vibe -> the Vibe window
  // only; kind=api -> the API window only; untagged -> both windows.
  override async keyUsage(ctx: UsageCtx): Promise<KeyUsageResult> {
    if (!ctx.enabled) {
      return {
        windows: [],
        unavailable: true,
        message: "Key disabled - usage not queried.",
      };
    }

    let res;
    try {
      res = await ctx.request(ctx.resolve("/v1/billing/budget"), {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-api-key": ctx.apiKey,
        },
        signal: ctx.signal,
      });
    } catch (err) {
      return {
        windows: [],
        unavailable: true,
        message: `Usage query failed: ${(err as Error).message}`,
      };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        windows: [],
        unavailable: true,
        message: "Budget endpoint rejected this key (HTTP 401/403).",
      };
    }
    if (!res.ok) {
      return {
        windows: [],
        unavailable: true,
        message: `Usage endpoint returned HTTP ${res.status}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = res.json();
    } catch {
      return {
        windows: [],
        unavailable: true,
        message: "Usage endpoint returned a non-JSON response.",
      };
    }
    if (!parsed || typeof parsed !== "object") {
      return {
        windows: [],
        unavailable: true,
        message: "Usage endpoint returned no budget data.",
      };
    }
    const root = parsed as Record<string, unknown>;

    // Each half: usage_percentage (0-100) of initial_budget, in the budget
    // currency, resetting at reset_at. readBudget narrows by the discriminating
    // field instead of an unchecked cast.
    const readBudget = (key: string): BudgetWindow | null => {
      const v = root[key];
      if (!v || typeof v !== "object") return null;
      const b = v as Record<string, unknown>;
      const pct = b.usage_percentage;
      const budget = b.initial_budget;
      if (typeof pct !== "number" || typeof budget !== "number") return null;
      return {
        used: Math.max(0, budget) * (clampPct(pct) / 100),
        limit: Math.max(0, budget),
        currency: typeof b.currency === "string" ? b.currency : null,
        resetsAt: typeof b.reset_at === "string" ? b.reset_at : undefined,
        message: b.payg_enabled === true ? "pay-as-you-go enabled" : null,
      };
    };

    const api = readBudget("api_budget");
    const vibe = readBudget("vibe_budget");
    if (!api && !vibe) {
      return {
        windows: [],
        unavailable: true,
        message: "Budget endpoint returned no budget halves.",
      };
    }

    // Tag decides which half a key reports; untagged keys see both.
    const kind = ctx.keyMetadata?.kind;
    const windows: ProviderKeyUsageWindow[] = [];
    if (kind !== "vibe" && api) windows.push(toWindow("mistral-api", "API usage (billing period)", api));
    if (kind !== "api" && vibe) windows.push(toWindow("mistral-vibe", "Vibe usage (billing period)", vibe));
    return { windows };
  }
}

// One billing/budget half, narrowed from the wire shape.
interface BudgetWindow {
  /** Absolute spend - budget * usage_percentage. */
  used: number;
  /** Budget ceiling for this period (0 when unlimited). */
  limit: number;
  currency: string | null;
  resetsAt?: string;
  message: string | null;
}

const clampPct = (pct: number) => Math.min(100, Math.max(0, pct));

// Compose a dashboard window. Currency folds into the label ("API usage
// (EUR)"); pay-as-you-go becomes the key's free-text note. A zero budget
// (unmetered) can't draw a meaningful bar, so it degrades to a used-only read.
function toWindow(
  id: string,
  labelBase: string,
  b: BudgetWindow,
): ProviderKeyUsageWindow {
  const label = b.currency
    ? `${labelBase} · ${b.currency === "USD" ? "$" : b.currency}`
    : labelBase;
  const note =
    b.limit > 0
      ? b.message
      : `unmetered budget - ${b.used.toFixed(2)} spent this period`;
  return {
    id,
    label,
    used: b.limit > 0 ? b.used : 0,
    limit: b.limit > 0 ? b.limit : 1,
    unit: "dollars",
    ...(b.resetsAt ? { resetsAt: b.resetsAt } : {}),
    ...(note ? { message: note } : {}),
  };
}

export const mistral = new MistralAdapter({
  id: "mistral",
  label: "Mistral",
  blurb: "Mistral AI models - OpenAI-compatible chat API.",
  brand: "mistral",
  docsUrl: "https://docs.mistral.ai/api/",
  defaults: {
    baseUrl: "https://api.mistral.ai",
    endpoints: [WireKind.Chat],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    { key: "name", label: "Name", placeholder: "mistral", required: true },
    {
      key: "apiKeys",
      label: "API key",
      placeholder: "sk-…",
      required: true,
      hint: "One per line - key metadata kind=vibe or kind=api limits the usage view to that budget; untagged keys show both.",
    },
  ],
  quirks: {
    // Mistral's chat schema rejects prompt_cache_retention (Responses-API
    // only) - the openai-cache family default would 422 every request.
    defaultTransforms: [],
  },
});
