// Shared local shapes + tiny helpers used by both the buffered request.ts/
// response.ts converters and the two streaming Transform classes in this
// folder. Split out so none of them needs to import from one another
// (avoids a circular dep) — same pattern as converters/chat-messages/shared.ts.

import crypto from "crypto";
import type { ChatMessage } from "../../wire";

// --- Local shape interfaces ----------------------------------------------
// The Chat + Responses REQUEST/RESPONSE bodies now use the shared wire types;
// only the Responses-specific OUTPUT item/body shapes are modeled locally,
// since they carry Responses-only fields the wire response type doesn't
// need. Bodies carry more than we model; index signatures pass the rest
// through opaquely.

export interface ResponseOutputItem {
  type: string;
  id?: string;
  role?: string;
  status?: string;
  content?: Array<Record<string, unknown>>;
  summary?: Array<{ type: string; text: string }>;
  call_id?: string;
  name?: string;
  arguments?: string;
  [k: string]: unknown;
}

export interface ResponseBody {
  id: string;
  object: "response";
  created_at: number;
  model?: string;
  status: string;
  output: ResponseOutputItem[];
  output_text?: string;
  system_fingerprint?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: unknown;
    output_tokens_details?: unknown;
  };
  [k: string]: unknown;
}

// Short random id with a prefix, OpenAI-style.
export function genId(prefix: string): string {
  return prefix + crypto.randomBytes(12).toString("hex");
}

// Map Chat Completions finish_reason -> Responses status.
export const FINISH_TO_STATUS: Record<string, string> = {
  stop: "completed",
  length: "incomplete",
  tool_calls: "completed",
  function_call: "completed",
  content_filter: "incomplete",
};

// The reverse of FINISH_TO_STATUS is lossy (both "stop" and "tool_calls" map
// to "completed"), so responsesResponseToChat() doesn't use a static lookup
// table here — it derives finish_reason from the actual output contents (a
// function_call item present -> "tool_calls", else "stop"), only falling
// back to this table for the one signal status alone carries: "incomplete"
// (length-truncated), which has no equivalent in the output shape itself.
export const STATUS_TO_FINISH: Record<string, string> = {
  incomplete: "length",
};

// --- Internal helpers for tool-call grouping during request translation ---

export interface ToolCallItem {
  __kind: "tool_call";
  role: string;
  tool_call: {
    id: string;
    type: string;
    function: { name: string; arguments: string };
  };
}

export interface ToolCallMessage extends ChatMessage {
  tool_calls: NonNullable<ChatMessage["tool_calls"]>;
}

export function isToolCallItem(
  m: ChatMessage | ToolCallItem,
): m is ToolCallItem {
  return (m as ToolCallItem).__kind === "tool_call";
}

// The local streaming-chunk shape both Transform classes build against.
export interface ChatCompletionChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  system_fingerprint?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
      reasoning?: string;
      reasoning_details?: Array<{
        type: string;
        text: string;
        format?: string;
        index?: number;
      }>;
      [k: string]: unknown;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: unknown;
    completion_tokens_details?: unknown;
  };
}
