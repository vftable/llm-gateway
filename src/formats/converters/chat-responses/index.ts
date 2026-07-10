// formats/converters/chat-responses — bidirectional bridge between the
// OpenAI Responses API (/v1/responses) and Chat Completions API
// (/v1/chat/completions). One of the two converter pairs under
// formats/converters/ (see chat-messages for the other); each pair owns a
// folder named `${from}-${to}` after the WireFmt tokens it bridges.
//
// Used by the gateway BOTH ways:
//   - to serve /v1/responses on models whose upstream only speaks Chat
//     Completions (a responses CLIENT, chat PROVIDER)
//   - to serve /v1/chat/completions (or /v1/messages, via a further hop
//     through chat<->messages — see pipeline.ts) on a provider whose upstream
//     only speaks Responses, e.g. OpenAI's GPT-5-class models, which
//     preferredEndpoint() pins to /v1/responses regardless of which endpoint
//     the client used (a chat/messages CLIENT, responses PROVIDER)
//
// Four buffered directions, plus their streaming counterparts:
//   responsesRequestToChat      — Responses-shaped client request -> Chat body
//   chatRequestToResponses      — Chat-shaped client request -> Responses body (inverse)
//   chatResponseToResponses     — Chat upstream response -> Responses body
//   responsesResponseToChat     — Responses upstream response -> Chat body (inverse)
//   StreamingResponsesBridgeTransform       — Chat upstream SSE -> Responses SSE
//   StreamingResponsesToChatBridgeTransform — Responses upstream SSE -> Chat SSE (inverse)
//
// Coverage (both directions, buffered AND streaming):
//   - Plain-string and item-array inputs (messages, multimodal parts)
//   - instructions <-> a leading system message
//   - tools / tool_choice shape (Responses is internally tagged, Chat wraps in
//     { type: 'function', function: {...} })
//   - function_call / function_call_output items <-> assistant tool_calls /
//     role:'tool' messages
//   - text.format (Responses) <-> response_format (Chat) for Structured Outputs
//   - reasoning.effort (Responses) <-> reasoning_effort (Chat)
//   - finish_reason <-> status mapping (the reverse direction re-derives
//     finish_reason from output CONTENTS rather than a static status lookup —
//     see STATUS_TO_FINISH's comment for why status alone is lossy)
//   - usage token-field renaming (prompt/completion <-> input/output)
//   - reasoning_details from our <thinking> conversion <-> reasoning output items
//
// Split across sibling files by concern:
//   shared.ts             — local types + genId/FINISH_TO_STATUS/STATUS_TO_FINISH
//   request.ts             — responsesRequestToChat / chatRequestToResponses
//   response.ts             — chatResponseToResponses / responsesResponseToChat
//   stream-to-responses.ts  — StreamingResponsesBridgeTransform (chat SSE -> responses SSE)
//   stream-to-chat.ts       — StreamingResponsesToChatBridgeTransform (responses SSE -> chat SSE)
//
// References:
//   https://platform.openai.com/docs/guides/migrate-to-responses

export { responsesRequestToChat, chatRequestToResponses } from "./request";
export { chatResponseToResponses, responsesResponseToChat } from "./response";
export { StreamingResponsesBridgeTransform } from "./stream-to-responses";
export { StreamingResponsesToChatBridgeTransform } from "./stream-to-chat";
export { genId } from "./shared";
export type { ResponsesStreamEvent } from "../../wire";
