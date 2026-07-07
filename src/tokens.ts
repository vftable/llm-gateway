// Token counting for request bodies and response usage extraction.
//
// Used by the gateway's context-window enforcement and per-key usage-limit
// middleware. Uses a coarse chars/4 heuristic — imprecise per-request but
// stable across every model the gateway serves, and accurate enough in
// aggregate for quota enforcement. Exact token counts reported by the
// upstream (when available) are reconciled after the response arrives; see
// reconcileUsage() in gateway/engine.ts.
//
// All public functions are synchronous and safe to call from request
// middleware. Counting never throws.

// Count tokens in a plain string. ~4 chars/token heuristic.
export function countTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// Approximate per-message overhead in tokens (role tag, separators, etc.).
// The exact value varies by model but ~4 is a fine rule-of-thumb.
const PER_MSG_OVERHEAD = 4;

// Count tokens in a message `content` field across all shapes the gateway
// sees. Content may be:
//   - plain string
//   - array of { type:'text', text }                    (OpenAI/Anthropic)
//   - array of { type:'input_text'|'output_text', text } (Responses)
//   - array of { type:'tool_use', input }               (Anthropic)
//   - array of { type:'tool_result', content }          (Anthropic)
//   - array of { type:'image_url', image_url:{url} }    (OpenAI vision)
//   - any unknown shape — falls back to JSON.stringify
function countContent(content: unknown): number {
  if (content == null) return 0;
  if (typeof content === "string") return countTextTokens(content);
  if (!Array.isArray(content)) return countTextTokens(JSON.stringify(content));
  let total = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") {
      total += countTextTokens(String(part ?? ""));
      continue;
    }
    const p = part as Record<string, unknown>;
    if (typeof p.text === "string") {
      total += countTextTokens(p.text);
    } else if (typeof p.input === "string") {
      // Anthropic tool_use.input is often an object; count its serialised form.
      total += countTextTokens(p.input);
    } else if (typeof p.input === "object" && p.input !== null) {
      total += countTextTokens(JSON.stringify(p.input));
    } else if (p.content != null) {
      // Anthropic tool_result.content can itself be a string or array of parts.
      total += countContent(p.content);
    } else {
      // Unknown part (image url, file, etc.) — count its JSON form so we
      // don't silently drop non-text payloads from the tally.
      total += countTextTokens(JSON.stringify(p));
    }
  }
  return total;
}

// Count input tokens in an Anthropic /v1/messages body.
// Includes: system, all messages, and tool definitions.
function countAnthropicBody(body: Record<string, unknown>): number {
  let total = 0;
  if (body.system != null) total += countContent(body.system);
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!m || typeof m !== "object") continue;
      total +=
        PER_MSG_OVERHEAD + countContent((m as Record<string, unknown>).content);
    }
  }
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) total += countTextTokens(JSON.stringify(t));
  }
  return total;
}

// Count input tokens in an OpenAI /v1/chat/completions body.
// Includes: messages, tool_calls on messages, and tool definitions.
function countChatBody(body: Record<string, unknown>): number {
  let total = 0;
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!m || typeof m !== "object") continue;
      const msg = m as Record<string, unknown>;
      total += PER_MSG_OVERHEAD + countContent(msg.content);
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls)
          total += countTextTokens(JSON.stringify(tc));
      }
    }
  }
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) total += countTextTokens(JSON.stringify(t));
  }
  return total;
}

// Count input tokens in an OpenAI /v1/responses body (pre-bridge shape).
// Includes: instructions, input (string or items), and tool definitions.
function countResponsesBody(body: Record<string, unknown>): number {
  let total = 0;
  if (typeof body.instructions === "string")
    total += countTextTokens(body.instructions);
  if (typeof body.input === "string") {
    total += PER_MSG_OVERHEAD + countTextTokens(body.input);
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      if (it.content != null)
        total += PER_MSG_OVERHEAD + countContent(it.content);
      else if (typeof it.arguments === "string")
        total += PER_MSG_OVERHEAD + countTextTokens(it.arguments);
      else if (it.output != null)
        total += PER_MSG_OVERHEAD + countContent(it.output);
      else total += PER_MSG_OVERHEAD;
    }
  }
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) total += countTextTokens(JSON.stringify(t));
  }
  return total;
}

// Count input tokens in a request body, picking the right algorithm from
// the request path. Returns 0 for unrecognised paths or non-object bodies.
// Never throws.
export function countInputTokens(body: unknown, path: string): number {
  if (!body || typeof body !== "object") return 0;
  const p = path.split("?")[0];
  try {
    if (p.endsWith("/messages"))
      return countAnthropicBody(body as Record<string, unknown>);
    if (p.endsWith("/chat/completions"))
      return countChatBody(body as Record<string, unknown>);
    if (p.endsWith("/responses"))
      return countResponsesBody(body as Record<string, unknown>);
  } catch {
    return 0;
  }
  return 0;
}

// Read the requested max output tokens from a request body across shapes.
// Returns undefined when the request didn't specify one (caller falls back
// to the model's maxOutputTokens).
export function readMaxOutputTokens(
  body: Record<string, unknown>,
): number | undefined {
  const m = body as {
    max_tokens?: number;
    max_completion_tokens?: number;
    max_output_tokens?: number;
  };
  if (typeof m.max_tokens === "number") return m.max_tokens;
  if (typeof m.max_completion_tokens === "number")
    return m.max_completion_tokens;
  if (typeof m.max_output_tokens === "number") return m.max_output_tokens;
  return undefined;
}

// Extract upstream-reported token usage from a parsed response body.
// Works across Anthropic, OpenAI Chat, and OpenAI Responses shapes.
// Returns {} when no usage info is present (e.g. passthrough / streaming).
//
// `cached` is prompt tokens served from the provider's prompt cache — reported
// as `cache_read_input_tokens` (Anthropic) or `prompt_tokens_details.cached_tokens`
// (OpenAI). It is a SUBSET of `input`, surfaced separately for cost visibility;
// it is not added on top of the input total.
export function readResponseUsage(body: unknown): {
  input?: number;
  output?: number;
  cached?: number;
} {
  if (!body || typeof body !== "object") return {};
  const u = (body as { usage?: unknown }).usage;
  if (!u || typeof u !== "object") return {};
  const o = u as Record<string, unknown>;
  const out: { input?: number; output?: number; cached?: number } = {};
  // OpenAI Chat: usage.{prompt_tokens, completion_tokens}
  if (typeof o.prompt_tokens === "number") out.input = o.prompt_tokens;
  if (typeof o.completion_tokens === "number") out.output = o.completion_tokens;
  // Anthropic / Responses: usage.{input_tokens, output_tokens}
  // (overrides the OpenAI names if both are somehow present)
  if (typeof o.input_tokens === "number") out.input = o.input_tokens;
  if (typeof o.output_tokens === "number") out.output = o.output_tokens;
  const cached = readCachedTokens(o);
  if (cached != null) out.cached = cached;
  return out;
}

// Pull cached (prompt-cache-hit) input tokens from a usage object across the
// three shapes. Returns null when the field isn't present.
export function readCachedTokens(o: Record<string, unknown>): number | null {
  // Anthropic: usage.cache_read_input_tokens
  if (typeof o.cache_read_input_tokens === "number")
    return o.cache_read_input_tokens;
  // OpenAI Chat/Responses: usage.prompt_tokens_details.cached_tokens
  const details = o.prompt_tokens_details ?? o.input_tokens_details;
  if (details && typeof details === "object") {
    const c = (details as Record<string, unknown>).cached_tokens;
    if (typeof c === "number") return c;
  }
  return null;
}
