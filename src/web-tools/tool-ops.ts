// Wire-agnostic tool surface.
//
// Tools + tool calls look different in each wire format:
//   - chat      tools[].function{name,description,parameters}; tool_calls[]
//   - messages  tools[]{name,description,input_schema}; tool_use / tool_result blocks
//   - responses tools[]{name,parameters,…}; function_call / function_call_output items
//
// The web-tool machinery needs to READ and WRITE tool definitions (and read a
// model's tool calls back out) regardless of which format a hop speaks — a Claude
// model served by an OpenAI-type provider needs the exact same web-tool injection
// as a native Anthropic hop. This module is the single place that knows the three
// shapes, so both the web-tool loop and any tagged transform edit tools through
// one API instead of hardcoding Anthropic Messages shape.

import type { WireFmt } from "../formats/pipeline";

// A tool definition in the gateway's neutral shape (what the web tools declare).
export interface NeutralToolDef {
  name: string;
  description?: string;
  /** JSON Schema for the tool's arguments. */
  schema?: unknown;
}

// A tool call a model emitted, normalized across formats.
export interface NeutralToolCall {
  id: string;
  name: string;
  /** Parsed arguments object (best-effort; {} when absent/unparseable). */
  input: Record<string, unknown>;
}

type Body = Record<string, unknown>;

// --- tool definitions ------------------------------------------------------

// Render a neutral tool def into the format's on-the-wire tool shape.
export function toWireToolDef(fmt: WireFmt, def: NeutralToolDef): Body {
  if (fmt === "chat") {
    return {
      type: "function",
      function: {
        name: def.name,
        ...(def.description != null ? { description: def.description } : {}),
        ...(def.schema != null ? { parameters: def.schema } : {}),
      },
    };
  }
  if (fmt === "responses") {
    // Responses tools are internally tagged function tools.
    return {
      type: "function",
      name: def.name,
      ...(def.description != null ? { description: def.description } : {}),
      ...(def.schema != null ? { parameters: def.schema } : {}),
    };
  }
  // messages
  return {
    name: def.name,
    ...(def.description != null ? { description: def.description } : {}),
    input_schema: def.schema ?? { type: "object", properties: {} },
  };
}

// Read the tool list off a request body (the raw wire array, untouched).
export function readTools(body: Body): unknown[] {
  return Array.isArray(body.tools) ? body.tools : [];
}

// Return a NEW body with `tools` replaced. Input body is not mutated.
export function writeTools(body: Body, tools: unknown[]): Body {
  return { ...body, tools };
}

// The name of a tool def in any format ("" when absent).
export function toolDefName(fmt: WireFmt, tool: unknown): string {
  if (!tool || typeof tool !== "object") return "";
  const t = tool as Body;
  if (fmt === "chat") {
    const fn = t.function as { name?: unknown } | undefined;
    if (fn && typeof fn.name === "string") return fn.name;
  }
  return typeof t.name === "string" ? t.name : "";
}

// --- tool calls ------------------------------------------------------------

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw))
    return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

// Read the tool calls a model emitted from a response, normalized. `source` is
// the format-native container: a chat message ({tool_calls}), the Anthropic
// content block array, or the Responses output item array.
export function readToolCalls(
  fmt: WireFmt,
  source: unknown,
): NeutralToolCall[] {
  const out: NeutralToolCall[] = [];
  if (fmt === "chat") {
    const msg = source as { tool_calls?: unknown } | undefined;
    const calls = Array.isArray(msg?.tool_calls) ? msg!.tool_calls : [];
    for (const cRaw of calls) {
      const c = (cRaw ?? {}) as Body;
      const fn = (c.function ?? {}) as { name?: unknown; arguments?: unknown };
      out.push({
        id: typeof c.id === "string" ? c.id : "",
        name: typeof fn.name === "string" ? fn.name : "",
        input: parseArgs(fn.arguments),
      });
    }
    return out;
  }
  if (fmt === "responses") {
    const items = Array.isArray(source) ? source : [];
    for (const iRaw of items) {
      const i = (iRaw ?? {}) as Body;
      if (i.type !== "function_call") continue;
      out.push({
        id: typeof i.call_id === "string" ? i.call_id : "",
        name: typeof i.name === "string" ? i.name : "",
        input: parseArgs(i.arguments),
      });
    }
    return out;
  }
  // messages: content block array
  const blocks = Array.isArray(source) ? source : [];
  for (const bRaw of blocks) {
    const b = (bRaw ?? {}) as Body;
    if (b.type !== "tool_use") continue;
    out.push({
      id: typeof b.id === "string" ? b.id : "",
      name: typeof b.name === "string" ? b.name : "",
      input: parseArgs(b.input),
    });
  }
  return out;
}

// Build a tool-result item in the format's native shape, to append back into a
// conversation (the value the model reads as the tool's output).
export function toolResult(
  fmt: WireFmt,
  call: { id: string },
  text: string,
): Body {
  if (fmt === "chat") {
    return { role: "tool", tool_call_id: call.id, content: text };
  }
  if (fmt === "responses") {
    return { type: "function_call_output", call_id: call.id, output: text };
  }
  return { type: "tool_result", tool_use_id: call.id, content: text };
}
