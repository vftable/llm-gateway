// Anthropic Messages API wire types (/v1/messages).
//
// We model only the fields the gateway reads or writes; everything else rides
// through opaquely via the `[k: string]: unknown` index signatures. This is the
// same "only what we touch" philosophy the converters already used with local
// interfaces — now shared, so transforms authored against the Messages format
// (onRequest("messages", …) / onResponse("messages", …)) get real types.

// --- content blocks --------------------------------------------------------

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl?: string } | null;
  [k: string]: unknown;
}

export interface AnthropicImageBlock {
  type: "image" | "input_image";
  source?: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
  url?: string;
  [k: string]: unknown;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  [k: string]: unknown;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
  [k: string]: unknown;
}

export interface AnthropicThinkingBlock {
  type: "thinking" | "redacted_thinking";
  thinking?: string;
  signature?: string;
  data?: string;
  [k: string]: unknown;
}

// Real Anthropic `thinking` blocks always carry a cryptographic `signature` —
// Anthropic verifies it when a client echoes the block back on a later turn
// (e.g. a tool-use continuation) and 400s if it's missing or invalid. When the
// gateway SYNTHESIZES a thinking block itself — extracting inline
// <thinking>...</thinking> tags from a non-Anthropic upstream's text, or
// bridging `reasoning_content`/reasoning output items from a Chat/Responses
// provider into Anthropic's shape — there is no real signature to carry
// forward (the upstream never produced one). Omitting `signature` entirely
// causes some clients/SDKs (including Anthropic's own) to reject the block
// as malformed on echo-back, so every synthesized thinking block gets this
// placeholder instead. It is NOT a valid Anthropic signature — it exists
// purely so the block's shape matches what a real `thinking` block looks
// like. It is never forwarded to a real upstream: `stripUnsupportedThinking`
// (see formats/converters/thinking-signature.ts) converts every thinking
// block — synthetic OR genuine — back into a plain text block before ANY
// request reaches a `messages`-speaking provider, because the gateway can
// never prove a signature it's echoing (synthetic or another account's real
// one) is valid for the upstream it's about to hit.
export const SYNTHETIC_THINKING_SIGNATURE = "llmapi-synthetic-thinking";

export interface AnthropicDocumentBlock {
  type: "document";
  source?: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
  [k: string]: unknown;
}

// A content block in either direction. Open union — the trailing
// `Record<string, unknown>` member keeps it a pure passthrough bag (any block
// the gateway builds or forwards is assignable) while the named members give
// authoring-time narrowing on `type`.
export type AnthropicBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicDocumentBlock
  | Record<string, unknown>;

// --- messages + tools ------------------------------------------------------

export interface AnthropicMessage {
  role: "user" | "assistant" | string;
  content: string | AnthropicBlock[];
  [k: string]: unknown;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: unknown;
  type?: string;
  [k: string]: unknown;
}

export type AnthropicToolChoice =
  | { type: "auto" | "any" | "none" }
  | { type: "tool"; name: string }
  | ({ type: string } & Record<string, unknown>);

export interface AnthropicThinkingConfig {
  type?: "enabled" | "adaptive" | string;
  budget_tokens?: number;
  [k: string]: unknown;
}

// --- usage -----------------------------------------------------------------

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  [k: string]: unknown;
}

// --- request ---------------------------------------------------------------

export interface AnthropicMessagesRequest {
  model?: string;
  messages?: AnthropicMessage[];
  system?: string | AnthropicTextBlock[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  thinking?: AnthropicThinkingConfig;
  metadata?: { user_id?: unknown; [k: string]: unknown };
  reasoning?: { effort?: unknown; [k: string]: unknown };
  reasoning_effort?: unknown;
  [k: string]: unknown;
}

// --- response (non-streaming) ----------------------------------------------

export interface AnthropicMessagesResponse {
  id?: string;
  type?: "message";
  role?: "assistant";
  model?: string;
  content?: AnthropicBlock[];
  stop_reason?: string | null;
  stop_sequence?: string | null;
  usage?: AnthropicUsage;
  [k: string]: unknown;
}

// --- streaming events ------------------------------------------------------
// The Messages SSE event union. Discriminated by `type`. Only the fields the
// gateway's bridges read/emit are modeled.

export interface AnthropicMessageStartEvent {
  type: "message_start";
  message: {
    id?: string;
    type?: "message";
    role?: "assistant";
    model?: string | null;
    content?: AnthropicBlock[];
    stop_reason?: string | null;
    stop_sequence?: string | null;
    usage?: AnthropicUsage;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface AnthropicContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block: AnthropicBlock;
  [k: string]: unknown;
}

export interface AnthropicTextDelta {
  type: "text_delta";
  text: string;
}
export interface AnthropicThinkingDelta {
  type: "thinking_delta";
  thinking: string;
}
export interface AnthropicInputJsonDelta {
  type: "input_json_delta";
  partial_json: string;
}
export interface AnthropicSignatureDelta {
  type: "signature_delta";
  signature: string;
}
export type AnthropicBlockDelta =
  | AnthropicTextDelta
  | AnthropicThinkingDelta
  | AnthropicInputJsonDelta
  | AnthropicSignatureDelta
  | ({ type: string } & Record<string, unknown>);

export interface AnthropicContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: AnthropicBlockDelta;
  [k: string]: unknown;
}

export interface AnthropicContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
  [k: string]: unknown;
}

export interface AnthropicMessageDeltaEvent {
  type: "message_delta";
  delta: {
    stop_reason?: string | null;
    stop_sequence?: string | null;
    [k: string]: unknown;
  };
  usage?: AnthropicUsage;
  [k: string]: unknown;
}

export interface AnthropicMessageStopEvent {
  type: "message_stop";
  [k: string]: unknown;
}

export interface AnthropicPingEvent {
  type: "ping";
  [k: string]: unknown;
}

export type AnthropicStreamEvent =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicPingEvent
  | ({ type: string } & Record<string, unknown>);
