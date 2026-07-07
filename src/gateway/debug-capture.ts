// Debug capture: distills the client request and the model response into
// compact, truncated JSON blobs for the Request Logs debug view. This is
// opt-in (settings.debugLogging) because it stores message content.
//
// Nothing here buffers the response stream — the streaming side is fed by the
// SseUsageObserver, which taps each SSE event as it passes through. This module
// only provides (a) request distillation from the already-parsed client body
// and (b) response distillation from a non-streaming parsed body.

// Per-field cap. Big enough to show structure + tool calls + the head of long
// content; small enough to keep the DB bounded. Truncation is marked inline.
export const MAX_DEBUG_FIELD = 16_000;
const MAX_STR = 2_000; // per individual string (a message's text, an arg blob)

// Truncate a string with a visible marker so debuggers know it was clipped.
function clip(s: string, max = MAX_STR): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[+${s.length - max} chars]`;
}

// Serialize + hard-cap the whole blob (defence in depth against huge inputs).
function pack(obj: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(obj);
  } catch {
    return '{"_error":"unserializable"}';
  }
  return s.length <= MAX_DEBUG_FIELD
    ? s
    : `${s.slice(0, MAX_DEBUG_FIELD)}…[+${s.length - MAX_DEBUG_FIELD} chars]`;
}

// Reduce a message `content` field (string or array of parts) to a compact,
// truncated shape across Anthropic / OpenAI / Responses.
function summarizeContent(content: unknown): unknown {
  if (content == null) return null;
  if (typeof content === "string") return clip(content);
  if (!Array.isArray(content)) return clip(JSON.stringify(content));
  return content.map((part) => {
    if (!part || typeof part !== "object") return clip(String(part));
    const p = part as Record<string, unknown>;
    const type = typeof p.type === "string" ? p.type : "?";
    if (typeof p.text === "string") return { type, text: clip(p.text) };
    if (type === "tool_use" || type === "tool_call")
      return {
        type,
        name: p.name ?? (p.function as Record<string, unknown>)?.name,
        input: clip(JSON.stringify(p.input ?? p.arguments ?? {})),
      };
    if (type === "tool_result")
      return {
        type,
        tool_use_id: p.tool_use_id,
        content: summarizeContent(p.content),
      };
    if (type.includes("image")) return { type, image: "<omitted>" };
    return { type, ...clipUnknownPart(p) };
  });
}

function clipUnknownPart(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === "type") continue;
    out[k] = typeof v === "string" ? clip(v, 300) : v;
  }
  return out;
}

// Distill tool definitions to name + description + parameter keys. This is the
// "what tools were offered to the model" side.
function summarizeTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((t) => {
    const tool = (t ?? {}) as Record<string, unknown>;
    // OpenAI wraps under { type:"function", function:{...} }; Anthropic is flat.
    const fn = (tool.function ?? tool) as Record<string, unknown>;
    const schema = (fn.parameters ?? fn.input_schema ?? {}) as Record<
      string,
      unknown
    >;
    const props = (schema.properties ?? {}) as Record<string, unknown>;
    return {
      name: fn.name,
      description:
        typeof fn.description === "string"
          ? clip(fn.description, 300)
          : undefined,
      params: Object.keys(props),
    };
  });
}

// Distill the client request body — what the client actually supplied to the
// model. Captures messages, system prompt, tools, tool_choice and sampling.
export function captureRequest(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages)
    ? (body.messages as Array<Record<string, unknown>>).map((m) => ({
        role: m.role,
        content: summarizeContent(m.content),
        ...(m.tool_calls ? { tool_calls: summarizeContent(m.tool_calls) } : {}),
        ...(m.name ? { name: m.name } : {}),
      }))
    : undefined;

  // Responses API uses `input` + `instructions` instead of messages/system.
  const input =
    body.input !== undefined ? summarizeContent(body.input) : undefined;

  const summary = {
    model: body.model,
    stream: body.stream === true,
    ...(body.system !== undefined
      ? { system: summarizeContent(body.system) }
      : {}),
    ...(typeof body.instructions === "string"
      ? { instructions: clip(body.instructions) }
      : {}),
    ...(messages ? { messages } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(summarizeTools(body.tools)
      ? { tools: summarizeTools(body.tools) }
      : {}),
    ...(body.tool_choice !== undefined
      ? { tool_choice: body.tool_choice }
      : {}),
    ...(body.temperature !== undefined
      ? { temperature: body.temperature }
      : {}),
    ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
    ...(body.max_completion_tokens !== undefined
      ? { max_completion_tokens: body.max_completion_tokens }
      : {}),
    ...(body.max_output_tokens !== undefined
      ? { max_output_tokens: body.max_output_tokens }
      : {}),
    ...(body.reasoning !== undefined ? { reasoning: body.reasoning } : {}),
    ...(body.thinking !== undefined ? { thinking: body.thinking } : {}),
  };
  return pack(summary);
}

export interface ResponseSummary {
  text?: string;
  toolCalls?: Array<{ name?: unknown; arguments?: string }>;
  stopReason?: unknown;
  refusal?: unknown;
}

// Distill a non-streaming parsed response (Anthropic / OpenAI / Responses) into
// text + tool calls + stop reason.
export function captureResponse(parsed: Record<string, unknown>): string {
  const s: ResponseSummary = {};
  const texts: string[] = [];
  const tools: Array<{ name?: unknown; arguments?: string }> = [];

  // Anthropic Messages: content[] blocks.
  if (Array.isArray(parsed.content)) {
    for (const block of parsed.content as Array<Record<string, unknown>>) {
      if (block?.type === "text" && typeof block.text === "string")
        texts.push(block.text);
      else if (block?.type === "thinking" && typeof block.thinking === "string")
        texts.push(`<thinking>${block.thinking}</thinking>`);
      else if (block?.type === "tool_use")
        tools.push({
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
    }
    if (parsed.stop_reason !== undefined) s.stopReason = parsed.stop_reason;
  }

  // OpenAI Chat: choices[].message.{content, tool_calls}.
  if (Array.isArray(parsed.choices)) {
    for (const ch of parsed.choices as Array<Record<string, unknown>>) {
      const msg = (ch.message ?? {}) as Record<string, unknown>;
      if (typeof msg.content === "string" && msg.content)
        texts.push(msg.content);
      if (msg.refusal) s.refusal = msg.refusal;
      if (Array.isArray(msg.tool_calls))
        for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
          const fn = (tc.function ?? {}) as Record<string, unknown>;
          tools.push({
            name: fn.name,
            arguments:
              typeof fn.arguments === "string"
                ? fn.arguments
                : JSON.stringify(fn.arguments ?? {}),
          });
        }
      if (ch.finish_reason !== undefined) s.stopReason = ch.finish_reason;
    }
  }

  // OpenAI Responses: output[] items.
  if (Array.isArray(parsed.output)) {
    for (const item of parsed.output as Array<Record<string, unknown>>) {
      if (item?.type === "message" && Array.isArray(item.content))
        for (const c of item.content as Array<Record<string, unknown>>)
          if (typeof c.text === "string") texts.push(c.text);
      if (item?.type === "function_call")
        tools.push({
          name: item.name,
          arguments:
            typeof item.arguments === "string"
              ? item.arguments
              : JSON.stringify(item.arguments ?? {}),
        });
    }
  }

  const text = texts.join("");
  if (text) s.text = clip(text);
  if (tools.length)
    s.toolCalls = tools.map((t) => ({
      name: t.name,
      arguments: t.arguments ? clip(t.arguments) : t.arguments,
    }));
  return pack(s);
}

// Cap a pre-built response summary (from the streaming observer) to the field
// limit. Text/args are already per-string clipped by the observer.
export function packResponseSummary(s: ResponseSummary): string {
  return pack(s);
}
