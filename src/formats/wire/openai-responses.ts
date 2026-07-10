// OpenAI Responses API wire types (/v1/responses).
//
// Only the fields the gateway reads or writes are modeled; the rest rides
// through via the `[k: string]: unknown` index signatures. Shared so transforms
// authored against the responses format (onRequest("responses", …) etc.) get
// real types.

// --- input items -----------------------------------------------------------

export interface ResponsesMessageItem {
  type?: "message";
  role: string;
  content?: unknown;
  [k: string]: unknown;
}
export interface ResponsesFunctionCallItem {
  type: "function_call";
  call_id?: string;
  name?: string;
  arguments?: unknown;
  [k: string]: unknown;
}
export interface ResponsesFunctionCallOutputItem {
  type: "function_call_output";
  call_id?: string;
  output?: unknown;
  [k: string]: unknown;
}
export interface ResponsesReasoningItem {
  type: "reasoning";
  id?: string;
  summary?: Array<{ type: string; text: string }>;
  status?: string;
  [k: string]: unknown;
}
export type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem
  | ResponsesReasoningItem
  | ({ type?: string } & Record<string, unknown>);

// --- usage -----------------------------------------------------------------

export interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: unknown;
  output_tokens_details?: unknown;
  [k: string]: unknown;
}

// --- request ---------------------------------------------------------------

export interface ResponsesRequest {
  model?: string;
  input?: string | ResponsesInputItem[];
  instructions?: string;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  stream?: boolean;
  parallel_tool_calls?: boolean;
  reasoning?: { effort?: unknown; [k: string]: unknown };
  text?: { format?: unknown; [k: string]: unknown };
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  metadata?: unknown;
  user?: string;
  [k: string]: unknown;
}

// --- response (non-streaming) ----------------------------------------------

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

export interface ResponsesResponse {
  id?: string;
  object?: "response";
  created_at?: number;
  model?: string;
  status?: string;
  output?: ResponseOutputItem[];
  output_text?: string;
  system_fingerprint?: string;
  usage?: ResponsesUsage;
  [k: string]: unknown;
}

// --- streaming events ------------------------------------------------------
// The Responses SSE event union. Discriminated by `type` (dotted names). Only
// the fields the gateway's bridge reads/emits are modeled; every event keeps an
// index signature for passthrough.

export interface ResponsesStreamEventBase {
  type: string;
  [k: string]: unknown;
}

export interface ResponsesCreatedEvent extends ResponsesStreamEventBase {
  type: "response.created" | "response.in_progress" | "response.completed";
  response?: Partial<ResponsesResponse>;
}
export interface ResponsesOutputItemEvent extends ResponsesStreamEventBase {
  type: "response.output_item.added" | "response.output_item.done";
  output_index?: number;
  item?: ResponseOutputItem;
}
export interface ResponsesContentPartEvent extends ResponsesStreamEventBase {
  type: "response.content_part.added" | "response.content_part.done";
  item_id?: string;
  output_index?: number;
  content_index?: number;
  part?: Record<string, unknown>;
}
export interface ResponsesTextDeltaEvent extends ResponsesStreamEventBase {
  type: "response.output_text.delta" | "response.text.done";
  item_id?: string;
  output_index?: number;
  content_index?: number;
  delta?: string;
  text?: string;
}
export interface ResponsesReasoningTextEvent extends ResponsesStreamEventBase {
  type: "response.reasoning_text.delta" | "response.reasoning_text.done";
  item_id?: string;
  output_index?: number;
  delta?: string;
  text?: string;
}
export interface ResponsesFunctionArgsEvent extends ResponsesStreamEventBase {
  type:
    | "response.function_call_arguments.delta"
    | "response.function_call_arguments.done";
  item_id?: string;
  output_index?: number;
  delta?: string;
  arguments?: string;
}

export type ResponsesStreamEvent =
  | ResponsesCreatedEvent
  | ResponsesOutputItemEvent
  | ResponsesContentPartEvent
  | ResponsesTextDeltaEvent
  | ResponsesReasoningTextEvent
  | ResponsesFunctionArgsEvent
  | ResponsesStreamEventBase;
