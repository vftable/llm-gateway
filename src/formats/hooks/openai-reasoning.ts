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

const OPENAI_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type OpenAIEffort = (typeof OPENAI_EFFORTS)[number];

// GPT-5.6+ supports max; GPT-5 family supports up to xhigh; older models cap at high.
const GPT56_RE = /^gpt-?5[\.\-]?[6-9]/i;
const GPT5_RE = /^gpt-?5/i;

function maxEffortForModel(model: string | undefined): OpenAIEffort {
  if (!model) return "high";
  if (GPT56_RE.test(model)) return "max";
  if (GPT5_RE.test(model)) return "xhigh";
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
  return clampEffortForModel(mapped, model);
}

export function budgetToLevel(budget: number, model?: string): OpenAIEffort {
  let level: OpenAIEffort;
  if (budget <= 4096) level = "low";
  else if (budget <= 16384) level = "medium";
  else if (budget <= 32768) level = "high";
  else if (budget <= 65536) level = "xhigh";
  else level = "max";
  return clampEffortForModel(level, model);
}

export function normalizeOpenAIReasoning(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!body || typeof body !== "object") return body;

  if ("messages" in body) return normalizeChatReasoning(body);
  if ("input" in body) return normalizeResponsesReasoning(body);
  return body;
}

function normalizeChatReasoning(
  body: Record<string, unknown>,
): Record<string, unknown> {
  // Strip gateway-internal and Anthropic-only fields that should never
  // reach an OpenAI-compatible upstream.
  delete body._reasoning_summary;
  stripAnthropicMetadata(body);

  if (body.reasoning_effort === undefined) return body;

  const model = typeof body.model === "string" ? body.model : undefined;
  const casted = toOpenAIEffort(body.reasoning_effort, model);
  if (casted) body.reasoning_effort = casted;

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
  sanitizeReasoningInputItems(body);

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

// Strip encrypted_content from reasoning input items (it's provider-specific
// and will 400 on any provider other than the one that produced it) and
// convert summary text to content blocks so the reasoning prose survives as
// plain text the model can read.
function sanitizeReasoningInputItems(body: Record<string, unknown>): void {
  const input = body.input;
  if (!Array.isArray(input)) return;

  for (const item of input) {
    if (!item || typeof item !== "object" || item.type !== "reasoning")
      continue;

    const r = item as Record<string, unknown>;

    delete r.encrypted_content;

    const summary = r.summary as
      Array<{ type?: string; text?: string }> | undefined;

    if (Array.isArray(summary) && summary.length) {
      const texts = summary
        .filter((s) => typeof s.text === "string" && s.text)
        .map((s) => ({ type: "summary_text", text: s.text }));

      if (texts.length) {
        r.content = texts;
      }
    }
  }
}
