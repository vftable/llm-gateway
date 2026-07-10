// Thinking / reasoning extraction — barrel.
//
// Everything the rest of the app needs to pull inline <thinking>/<reasoning>
// blocks out of upstream responses and surface them as native reasoning fields:
//   - converter.ts       ThinkingConverter (non-streaming, whole-body scan)
//   - stream.ts           StreamingThinkingParser (per-chunk state machine)
//   - chat-stream.ts      SseThinkingTransform (streaming, Chat SSE)
//   - messages-stream.ts  AnthropicThinkingTransform (streaming, Messages SSE)
//   - transforms.ts       defaultThinkingResponse / defaultThinkingStream
//                         (tagged all-provider pipeline defaults — the seam
//                         that wires converter.ts/chat-stream.ts/
//                         messages-stream.ts into every route)
//   - tags.ts             the single shared tag vocabulary every scanner builds on
//
// Import from "…/formats/thinking", not the individual files.

export { ThinkingConverter, type ReasoningDetailEntry } from "./converter";
export {
  StreamingThinkingParser,
  type ThinkingDelta,
  stripInvisible,
} from "./stream";
export { SseThinkingTransform } from "./chat-stream";
export { AnthropicThinkingTransform } from "./messages-stream";
export { defaultThinkingResponse, defaultThinkingStream } from "./transforms";
