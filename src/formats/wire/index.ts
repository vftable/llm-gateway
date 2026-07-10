// Shared wire-format types — barrel + format→type mapping.
//
// Three wire formats the gateway speaks: "chat" (OpenAI Chat Completions),
// "messages" (Anthropic Messages), "responses" (OpenAI Responses). The mapping
// helpers below tie a format literal to its request / response / streaming-event
// type, so the tagged transform factories in pipeline.ts can infer the body type
// from the format tag alone.
//
// `WireFmt` is re-declared here (identical string union to pipeline's) so the
// wire/ module has no dependency back on pipeline — pipeline imports from here.

export * from "./anthropic";
export * from "./openai-chat";
export * from "./openai-responses";
export * from "./models";

import type {
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicStreamEvent,
} from "./anthropic";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from "./openai-chat";
import type {
  ResponsesRequest,
  ResponsesResponse,
  ResponsesStreamEvent,
} from "./openai-responses";

// The wire-format discriminant. Kept in lockstep with pipeline.ts `WireFmt`.
export type WireFmt = "chat" | "messages" | "responses";

// Request body type for a wire format.
export type WireRequest<F extends WireFmt> = F extends "chat"
  ? ChatCompletionRequest
  : F extends "messages"
    ? AnthropicMessagesRequest
    : ResponsesRequest;

// Non-streaming response body type for a wire format.
export type WireResponse<F extends WireFmt> = F extends "chat"
  ? ChatCompletionResponse
  : F extends "messages"
    ? AnthropicMessagesResponse
    : ResponsesResponse;

// Streaming event type for a wire format (one parsed SSE event).
export type WireStreamEvent<F extends WireFmt> = F extends "chat"
  ? ChatCompletionChunk
  : F extends "messages"
    ? AnthropicStreamEvent
    : ResponsesStreamEvent;
