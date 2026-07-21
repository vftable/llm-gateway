// OpenAI reasoning normalization (request hook).
//
// Normalizes reasoning fields on Chat and Responses request bodies bound for
// an OpenAI-compatible provider:
//
//   - effort: cast to OpenAI's valid set, model-aware clamping
//       older models: low | medium | high
//       GPT-5 family: + xhigh
//       GPT-5.6+:     + max
//   - summary: default to "detailed" when effort is present but summary is
//     absent, so reasoning summaries are always returned
//   - input reasoning items: strip encrypted_content (provider-specific,
//     would 400 on a different provider) and convert summary text to content
//     blocks so reasoning prose is visible to the model
//
// Runs as an all-provider default (DEFAULT_TRANSFORMS), tagged "chat" and
// "responses", gated on providerFmt so it only fires for OpenAI-compatible hops.

import {
  isGlm52Plus,
  isGlmModel,
  isGpt56Plus,
  isGpt5Family,
} from "../model-version";

const GLM_CATALOG_ID = "glm-coding";

export interface ReasoningNormalizationContext {
  catalogId?: string | null;
}

const OPENAI_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type OpenAIEffort = (typeof OPENAI_EFFORTS)[number];

function maxEffortForModel(model: string | undefined): OpenAIEffort {
  if (!model) return "high";
  if (isGpt56Plus(model)) return "max";
  if (isGpt5Family(model)) return "xhigh";
  return "high";
}

const EFFORT_RANK: Record<OpenAIEffort, number> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
};

export function clampEffortForModel(
  effort: OpenAIEffort,
  model?: string,
): OpenAIEffort {
  const cap = maxEffortForModel(model);
  return EFFORT_RANK[effort] <= EFFORT_RANK[cap] ? effort : cap;
}

export function toOpenAIEffort(
  value: unknown,
  model?: string,
  clamp = true,
): OpenAIEffort | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.toLowerCase();

  let mapped: OpenAIEffort | undefined;

  if (v === "low" || v === "min" || v === "minimal" || v === "lowest")
    mapped = "low";
  else if (v === "medium") mapped = "medium";
  else if (v === "high" || v === "highest") mapped = "high";
  else if (
    v === "xhigh" ||
    v === "x-high" ||
    v === "extra-high" ||
    v === "extra_high"
  )
    mapped = "xhigh";
  else if (v === "max" || v === "maximum") mapped = "max";

  if (!mapped) return undefined;
  return clamp ? clampEffortForModel(mapped, model) : mapped;
}

export function budgetToLevel(
  budget: number,
  model?: string,
  clamp = true,
): OpenAIEffort {
  let level: OpenAIEffort;
  if (budget <= 4096) level = "low";
  else if (budget <= 16384) level = "medium";
  else if (budget <= 32768) level = "high";
  else if (budget <= 65536) level = "xhigh";
  else level = "max";
  return clamp ? clampEffortForModel(level, model) : level;
}

export function normalizeOpenAIReasoning(
  body: Record<string, unknown>,
  context: ReasoningNormalizationContext = {},
): Record<string, unknown> {
  if (!body || typeof body !== "object") return body;

  if ("messages" in body) return normalizeChatReasoning(body, context);
  if ("input" in body) return normalizeResponsesReasoning(body);
  return body;
}

function normalizeChatReasoning(
  body: Record<string, unknown>,
  context: ReasoningNormalizationContext,
): Record<string, unknown> {
  // Strip gateway-internal and Anthropic-only fields that should never
  // reach an OpenAI-compatible upstream.
  delete body._reasoning_summary;
  stripAnthropicMetadata(body);

  const model = typeof body.model === "string" ? body.model : undefined;
  if (
    context.catalogId === GLM_CATALOG_ID &&
    typeof model === "string" &&
    isGlmModel(model)
  )
    return normalizeGlmChatReasoning(body, model);

  if (body.reasoning_effort === undefined) return body;

  const casted = toOpenAIEffort(body.reasoning_effort, model);
  if (casted) body.reasoning_effort = casted;

  return body;
}

type GlmEffort =
  "low" | "medium" | "high" | "xhigh" | "max" | "minimal" | "none";

function toGlmEffort(value: unknown): GlmEffort | undefined {
  if (typeof value !== "string") return undefined;
  const effort = value.toLowerCase();
  if (
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh" ||
    effort === "max" ||
    effort === "minimal" ||
    effort === "none"
  )
    return effort;
  if (effort === "maximum") return "max";
  if (effort === "x-high" || effort === "extra-high" || effort === "extra_high")
    return "xhigh";
  if (effort === "highest") return "high";
  if (effort === "min" || effort === "lowest") return "minimal";
  return undefined;
}

function normalizeGlmChatReasoning(
  body: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const rawEffort = body.reasoning_effort;
  if (rawEffort === undefined) return body;

  const effort = toGlmEffort(rawEffort);
  if (!effort) return body;

  const existingThinking =
    body.thinking && typeof body.thinking === "object"
      ? (body.thinking as Record<string, unknown>)
      : {};
  const explicitlyDisabled = existingThinking.type === "disabled";
  const skipThinking = effort === "minimal" || effort === "none";

  if (skipThinking || explicitlyDisabled) {
    body.thinking = { ...existingThinking, type: "disabled" };
    delete body.reasoning_effort;
    return body;
  }

  body.thinking = { ...existingThinking, type: "enabled" };
  if (isGlm52Plus(model)) body.reasoning_effort = effort;
  else delete body.reasoning_effort;
  return body;
}

function normalizeResponsesReasoning(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const reasoning = body.reasoning as
    { effort?: unknown; summary?: unknown; [k: string]: unknown } | undefined;

  const model = typeof body.model === "string" ? body.model : undefined;

  if (reasoning && typeof reasoning === "object") {
    if (reasoning.effort !== undefined) {
      const casted = toOpenAIEffort(reasoning.effort, model);
      if (casted) reasoning.effort = casted;

      if (reasoning.summary === undefined) {
        reasoning.summary = "detailed";
      }
    }
  }

  // OpenAI Responses API requires max_output_tokens >= 16.
  const mot = body.max_output_tokens;
  if (typeof mot === "number" && mot < 16) body.max_output_tokens = 16;

  stripAnthropicMetadata(body);
  sanitizeReasoningInputItems(body, model);

  return body;
}

// Strip Anthropic-shaped metadata that would cause a 400 on OpenAI
// upstreams. metadata.user_id is Anthropic-only; OpenAI rejects it.
function stripAnthropicMetadata(body: Record<string, unknown>): void {
  const meta = body.metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta === "object" && "user_id" in meta) {
    delete meta.user_id;
    if (Object.keys(meta).length === 0) delete body.metadata;
  }
}

// Sanitize reasoning input items for cross-provider forwarding. Raw content
// and provider-specific encrypted_content are never forwarded; summary is the
// only portable reasoning prose, for every model including codex-auto-review.
function sanitizeReasoningInputItems(
  body: Record<string, unknown>,
  _model: string | undefined,
): void {
  const input = body.input;
  if (!Array.isArray(input)) return;

  for (const item of input) {
    if (!item || typeof item !== "object" || item.type !== "reasoning")
      continue;

    const r = item as Record<string, unknown>;
    delete r.content;
    delete r.encrypted_content;
  }
}
