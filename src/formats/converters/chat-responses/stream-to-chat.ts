// Streaming bridge: Responses SSE -> Chat Completions SSE.
//
// The inverse of stream-from-chat.ts's StreamingResponsesBridgeTransform —
// needed so a chat/messages CLIENT streaming against a responses-NATIVE
// provider gets back chat-shaped SSE chunks (paired with
// requestFromChatCompletions() for the request side). Reads the same
// `response.*` event vocabulary that class emits and reduces it back to
// `chat.completion.chunk` deltas: text deltas -> delta.content, reasoning
// deltas -> delta.reasoning_content (Chat's own streaming reasoning field —
// see the thinking pipeline), function_call_arguments deltas ->
// delta.tool_calls[].function.arguments, response.completed -> the terminal
// chunk (finish_reason + usage) + [DONE].

import { Transform, type TransformCallback } from "stream";
import { SseFrameReader } from "../../sse/frame";
import type {
  ChatUsage,
  ResponsesResponse,
  ResponsesStreamEvent,
} from "../../wire";
import {
  genId,
  STATUS_TO_FINISH,
  type ChatCompletionChunk,
  type ResponseOutputItem,
} from "./shared";

export class StreamingResponsesToChatBridgeTransform extends Transform {
  private readonly reader = new SseFrameReader();
  private id: string | null = null;
  private created: number | null = null;
  private model: string | null = null;
  private systemFingerprint: string | null = null;
  private sentRole = false;
  // Responses output_index -> the Chat tool_calls[] index it's streamed as
  // (Chat tool_calls are positionally indexed within ONE message, Responses
  // output items are indexed within the whole response — these two index
  // spaces aren't the same, so a mapping is needed rather than reusing the
  // Responses index directly).
  private toolCallIndex = new Map<number, number>();
  private nextToolCallIndex = 0;
  private finished = false;

  constructor() {
    super({ objectMode: false, highWaterMark: 0 });
  }

  _transform(
    chunk: Buffer,
    _encoding: string,
    callback: TransformCallback,
  ): void {
    for (const raw of this.reader.feed(chunk)) this.processEvent(raw);
    callback();
  }

  _flush(callback: TransformCallback): void {
    const tail = this.reader.flush();
    if (tail) this.processEvent(tail);
    if (!this.finished) this.finish("stop");
    callback();
  }

  private processEvent(raw: string): void {
    const lines = raw.split("\n");
    let dataStr = "";
    for (const line of lines) {
      if (line.startsWith("data:")) {
        const payload = line.slice(5);
        dataStr += payload.startsWith(" ") ? payload.slice(1) : payload;
      }
    }
    if (!dataStr || dataStr === "[DONE]") return; // Responses SSE has no [DONE] sentinel of its own; response.completed is the terminal signal.
    let event: ResponsesStreamEvent;
    try {
      event = JSON.parse(dataStr);
    } catch {
      return;
    }
    this.handleEvent(event);
  }

  private ensureHeader(): void {
    if (this.sentRole) return;
    this.sentRole = true;
    this.pushChunk({ role: "assistant", content: "" });
  }

  private handleEvent(event: ResponsesStreamEvent): void {
    switch (event.type) {
      case "response.created":
      case "response.in_progress": {
        const r = (event as { response?: Partial<ResponsesResponse> }).response;
        if (r) {
          this.id = this.id ?? r.id ?? null;
          this.created = this.created ?? r.created_at ?? null;
          this.model = this.model ?? r.model ?? null;
          this.systemFingerprint =
            this.systemFingerprint ?? r.system_fingerprint ?? null;
        }
        this.ensureHeader();
        break;
      }
      case "response.output_text.delta": {
        const e = event as { delta?: string };
        if (e.delta) {
          this.ensureHeader();
          this.pushChunk({ content: e.delta });
        }
        break;
      }
      case "response.reasoning_text.delta":
      case "response.reasoning_summary_text.delta": {
        const e = event as { delta?: string };
        if (e.delta) {
          this.ensureHeader();
          this.pushChunk({ reasoning_content: e.delta });
        }
        break;
      }
      case "response.output_item.added": {
        const e = event as {
          output_index?: number;
          item?: ResponseOutputItem;
        };
        if (e.item?.type === "function_call" && e.output_index != null) {
          this.ensureHeader();
          const idx = this.nextToolCallIndex++;
          this.toolCallIndex.set(e.output_index, idx);
          this.pushChunk({
            tool_calls: [
              {
                index: idx,
                id: e.item.call_id || genId("call_"),
                type: "function",
                function: { name: e.item.name || "", arguments: "" },
              },
            ],
          });
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const e = event as { output_index?: number; delta?: string };
        if (e.delta != null && e.output_index != null) {
          const idx = this.toolCallIndex.get(e.output_index);
          if (idx != null) {
            this.ensureHeader();
            this.pushChunk({
              tool_calls: [{ index: idx, function: { arguments: e.delta } }],
            });
          }
        }
        break;
      }
      case "response.completed": {
        const r = (event as { response?: Partial<ResponsesResponse> }).response;
        const output = Array.isArray(r?.output) ? r.output : [];
        const hasToolCalls = output.some((o) => o?.type === "function_call");
        const finish =
          r?.status && STATUS_TO_FINISH[r.status]
            ? STATUS_TO_FINISH[r.status]
            : hasToolCalls
              ? "tool_calls"
              : "stop";
        this.finish(finish, r?.usage);
        break;
      }
      // response.output_item.done / content_part.* / text.done /
      // reasoning_text.done — purely structural close events on the Responses
      // side; Chat's SSE has no equivalent framing (a Chat stream just stops
      // sending deltas for a field), so there's nothing to emit for them.
    }
  }

  private finish(
    finishReason: string,
    usage?: ResponsesResponse["usage"],
  ): void {
    if (this.finished) return;
    this.finished = true;
    this.ensureHeader();
    const chunk: ChatCompletionChunk = {
      id: this.id || genId("chatcmpl_"),
      object: "chat.completion.chunk",
      created: this.created || Math.floor(Date.now() / 1000),
      model: this.model || undefined,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    };
    if (this.systemFingerprint)
      chunk.system_fingerprint = this.systemFingerprint;
    if (usage) {
      chunk.usage = {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        total_tokens: usage.total_tokens,
        prompt_tokens_details: usage.input_tokens_details as
          ChatUsage["prompt_tokens_details"] | undefined,
        completion_tokens_details: usage.output_tokens_details,
      };
    }
    this.push(`data: ${JSON.stringify(chunk)}\n\n`);
    this.push("data: [DONE]\n\n");
  }

  private pushChunk(
    delta: NonNullable<
      NonNullable<ChatCompletionChunk["choices"]>[number]["delta"]
    >,
  ): void {
    const chunk: ChatCompletionChunk = {
      id: this.id || genId("chatcmpl_"),
      object: "chat.completion.chunk",
      created: this.created || Math.floor(Date.now() / 1000),
      model: this.model || undefined,
      choices: [{ index: 0, delta, finish_reason: null }],
    };
    this.push(`data: ${JSON.stringify(chunk)}\n\n`);
  }
}
