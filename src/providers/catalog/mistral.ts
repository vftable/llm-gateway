import {
  OpenAICompatibleAdapter,
  type UsageCtx,
  type KeyUsageResult,
} from "../base";
import { WireKind, type Provider, type ProviderKeyUsageWindow } from "../../types";
import type { AnyRequestTransform } from "../../formats/pipeline";
import { onRequest } from "../../formats/pipeline";

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
