// formats/converters/chat-messages — bidirectional bridge between the
// Anthropic Messages API (/v1/messages) and the OpenAI Chat Completions API
// (/v1/chat/completions). One of the two converter pairs under
// formats/converters/ (see chat-responses for the other); each pair owns a
// folder named `${from}-${to}` after the WireFmt tokens it bridges.
//
// Used by the gateway when a model's chosen provider endpoint speaks a
// different wire format than the client. The request side converts the body
// the client sent into the provider's shape; the response side converts the
// provider's reply back into the client's shape. Streaming responses are
// converted chunk-by-chunk via the two transform streams below.
//
// Coverage:
//   - text content (string and part arrays)
//   - system prompt (system message <-> `system` field)
//   - images (anthropic image source <-> openai image_url)
//   - tools (input_schema <-> parameters) and tool_choice shapes
//   - tool_use <-> assistant tool_calls; tool_result <-> role:'tool'
//   - stop_reason / finish_reason mapping
//   - usage token-field renaming
//   - reasoning_effort passthrough
//
// We only model the fields we touch; everything else is passed through
// opaquely via index signatures.
//
// Split across sibling files by concern:
//   shared.ts             — genId, usage/content/tools translation, safeParse
//   request.ts             — messagesRequestToChat / chatRequestToMessages
//   response.ts             — chatResponseToMessages / messagesResponseToChat
//   stream-to-messages.ts   — ChatToMessagesSseTransform (chat SSE -> messages SSE)
//   stream-to-chat.ts       — MessagesToChatSseTransform (messages SSE -> chat SSE)

export { messagesRequestToChat, chatRequestToMessages } from "./request";
export { chatResponseToMessages, messagesResponseToChat } from "./response";
export { ChatToMessagesSseTransform } from "./stream-to-messages";
export { MessagesToChatSseTransform } from "./stream-to-chat";
