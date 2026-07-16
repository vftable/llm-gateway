// OpenAI Chat Completions wire types (/v1/chat/completions).
//
// Only the fields the gateway reads or writes are modeled; the rest rides
// through via the `[k: string]: unknown` index signatures. Shared so transforms
// authored against the chat format (onRequest("chat", …) / onResponse("chat", …)
// / onStreamEvent("chat", …)) get real types.

// --- content + tools -------------------------------------------------------

export interface ChatTextPart {
  type: "text" | "input_text" | "output_text";
  text: string;
  [k: string]: unknown;
}
export interface ChatImagePart {
  type: "image_url";
  image_url: { url: string; detail?: string };
  [k: string]: unknown;
}
export type ChatContentPart =
  ChatTextPart | ChatImagePart | ({ type: string } & Record<string, unknown>);

export interface ChatToolCall {
  id: string;
  type: "function" | string;
  // arguments is a JSON string; optional because streaming deltas and some
  // upstreams omit it on the opening chunk.
  function: { name: string; arguments?: string };
  index?: number;
  [k: string]: unknown;
}

// A reasoning-detail entry. The gateway emits the { type:'reasoning.text', text }
// shape from <thinking> extraction; some vendors use { type:'reasoning',
// summary:[…] }. Modeled loosely (the fields the bridge reads) + passthrough.
export interface ChatReasoningDetail {
  type?: string;
  text?: string;
  format?: string;
  index?: number;
  summary?: Array<{ type?: string; text?: string }>;
  [k: string]: unknown;
}

export interface ChatMessage {
  role: string;
  content?: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
  // gateway-attached reasoning fields (from <thinking> extraction / bridging)
  reasoning?: string;
  reasoning_content?: string;
  reasoning_details?: ChatReasoningDetail[];
  [k: string]: unknown;
}

export interface ChatTool {
  type: "function" | string;
  function: { name: string; description?: string; parameters?: unknown };
  [k: string]: unknown;
}

export type ChatToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } }
  | ({ type: string } & Record<string, unknown>);

// --- usage -----------------------------------------------------------------

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    audio_tokens?: number;
    [k: string]: unknown;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
    audio_tokens?: number;
    accepted_prediction_tokens?: number;
    rejected_prediction_tokens?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

// --- request ---------------------------------------------------------------

export interface ChatCompletionRequest {
  model?: string;
  messages?: ChatMessage[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  stop?: string | string[];
  seed?: number;
  user?: string;
  stream?: boolean;
  logprobs?: boolean;
  top_logprobs?: number;
  parallel_tool_calls?: boolean;
  reasoning_effort?: unknown;
  response_format?: unknown;
  metadata?: unknown;
  tools?: ChatTool[];
  tool_choice?: ChatToolChoice;
  [k: string]: unknown;
}

// --- response (non-streaming) ----------------------------------------------

export interface ChatChoice {
  index?: number;
  message?: ChatMessage;
  finish_reason?: string | null;
  [k: string]: unknown;
}

export interface ChatCompletionResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  system_fingerprint?: string;
  choices?: ChatChoice[];
  usage?: ChatUsage;
  [k: string]: unknown;
}

// --- streaming chunk -------------------------------------------------------

export interface ChatDelta {
  role?: string;
  content?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
  reasoning?: string;
  reasoning_content?: string;
  reasoning_details?: ChatReasoningDetail[];
  [k: string]: unknown;
}

export interface ChatChunkChoice {
  index?: number;
  delta?: ChatDelta;
  finish_reason?: string | null;
  [k: string]: unknown;
}

export interface ChatCompletionChunk {
  id?: string;
  object?: "chat.completion.chunk" | string;
  created?: number;
  model?: string;
  system_fingerprint?: string;
  choices?: ChatChunkChoice[];
  usage?: ChatUsage;
  [k: string]: unknown;
}
