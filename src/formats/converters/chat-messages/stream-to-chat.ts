// Anthropic Messages SSE -> Chat SSE chunks.
//
// Walks Anthropic content_block_start/delta/stop + message_delta/stop and
// emits chat.completion.chunk objects with delta.content / tool_calls /
// finish_reason + usage on the final chunk.

import { Transform, type TransformCallback } from "stream";
import { SseFrameReader, parseSseData } from "../../sse/frame";
import type { AnthropicUsage } from "../../wire";
import { genId, num, STOP_TO_FINISH, anthropicUsageToChat } from "./shared";

export class MessagesToChatSseTransform extends Transform {
  private readonly reader = new SseFrameReader();
  private started = false;
  private readonly model: string | null;
  // Map anthropic block index -> chat tool index + accumulating id/name.
  private toolBlocks = new Map<
    number,
    { chatIndex: number; id: string; name: string }
  >();
  private nextToolChatIndex = 0;
  private finishReason: string | null = null;
  // S2: accumulate Anthropic-shaped usage. Anthropic sends input + cache in
  // message_start and only output_tokens in message_delta, so we merge across
  // events and convert to OpenAI shape once, at message_stop.
  private anthUsage: AnthropicUsage = {};

  constructor(model?: string | null) {
    super();
    this.model = model ?? null;
  }

  _transform(chunk: Buffer, _enc: string, cb: TransformCallback): void {
    for (const evt of this.reader.feed(chunk)) this.handleEvent(evt);
    cb();
  }

  _flush(cb: TransformCallback): void {
    const tail = this.reader.flush();
    if (tail) this.handleEvent(tail);
    if (this.started && this.finishReason == null) {
      this.emitChunk(
        { finish_reason: "stop" },
        { usage: anthropicUsageToChat(this.anthUsage) },
      );
      this.emitDone();
    }
    cb();
  }

  private emitChunk(
    delta: Record<string, unknown>,
    extra?: Record<string, unknown>,
  ): void {
    const obj: Record<string, unknown> = {
      id: genId("chatcmpl-"),
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.model ?? "",
      choices: [{ index: 0, delta, finish_reason: null }],
    };
    if (extra) Object.assign(obj, extra);
    this.push(`data: ${JSON.stringify(obj)}\n\n`);
  }

  private emitDone(): void {
    this.push("data: [DONE]\n\n");
  }

  private start(): void {
    this.started = true;
    this.emitChunk({ role: "assistant", content: "" });
  }

  private handleEvent(raw: string): void {
    const dataStr = parseSseData(raw).data;
    if (!dataStr) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataStr);
    } catch {
      return;
    }
    if (!this.started) this.start();

    // Dispatch on the Anthropic SSE event type. Each case maps one Anthropic
    // event onto the equivalent chat.completion.chunk emission; unknown types
    // fall through (default) and are ignored.
    switch (data.type as string) {
      case "message_start":
        this.onMessageStart(data);
        break;
      case "content_block_start":
        this.onContentBlockStart(data);
        break;
      case "content_block_delta":
        this.onContentBlockDelta(data);
        break;
      case "message_delta":
        this.onMessageDelta(data);
        break;
      case "message_stop":
        this.onMessageStop();
        break;
    }
  }

  // S2: capture input + cache tokens (message_delta later carries only output).
  private onMessageStart(data: Record<string, unknown>): void {
    const u = (data.message as { usage?: AnthropicUsage } | undefined)?.usage;
    if (!u || typeof u !== "object") return;
    this.anthUsage.input_tokens = num(u.input_tokens);
    if (num(u.cache_read_input_tokens) > 0)
      this.anthUsage.cache_read_input_tokens = u.cache_read_input_tokens;
    if (num(u.cache_creation_input_tokens) > 0)
      this.anthUsage.cache_creation_input_tokens =
        u.cache_creation_input_tokens;
  }

  private onContentBlockStart(data: Record<string, unknown>): void {
    const block = data.content_block as Record<string, unknown> | undefined;
    if (block?.type !== "tool_use") return;
    const idx = data.index as number;
    const chatIndex = this.nextToolChatIndex++;
    this.toolBlocks.set(idx, {
      chatIndex,
      id: (block.id as string) || genId("call_"),
      name: (block.name as string) ?? "",
    });
    this.emitChunk({
      tool_calls: [
        {
          index: chatIndex,
          id: block.id,
          type: "function",
          function: { name: block.name ?? "", arguments: "" },
        },
      ],
    });
  }

  private onContentBlockDelta(data: Record<string, unknown>): void {
    const delta = data.delta as Record<string, unknown> | undefined;
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      this.emitChunk({ content: delta.text });
    } else if (
      delta?.type === "thinking_delta" &&
      typeof delta.thinking === "string"
    ) {
      // S1: Anthropic thinking_delta -> OpenAI reasoning_content delta.
      this.emitChunk({ reasoning_content: delta.thinking });
    } else if (
      delta?.type === "input_json_delta" &&
      typeof delta.partial_json === "string"
    ) {
      const tb = this.toolBlocks.get(data.index as number);
      if (tb) {
        this.emitChunk({
          tool_calls: [
            {
              index: tb.chatIndex,
              function: { arguments: delta.partial_json },
            },
          ],
        });
      }
    }
  }

  private onMessageDelta(data: Record<string, unknown>): void {
    const d = data.delta as Record<string, unknown> | undefined;
    if (d && typeof d.stop_reason === "string") {
      this.finishReason = STOP_TO_FINISH[d.stop_reason] ?? "stop";
    }
    // S2: message_delta carries output_tokens (and sometimes re-states
    // input/cache). Merge, keeping any cache captured at message_start.
    const u = data.usage as AnthropicUsage | undefined;
    if (!u) return;
    if (typeof u.output_tokens === "number")
      this.anthUsage.output_tokens = u.output_tokens;
    if (typeof u.input_tokens === "number")
      this.anthUsage.input_tokens = u.input_tokens;
    if (num(u.cache_read_input_tokens) > 0)
      this.anthUsage.cache_read_input_tokens = u.cache_read_input_tokens;
    if (num(u.cache_creation_input_tokens) > 0)
      this.anthUsage.cache_creation_input_tokens =
        u.cache_creation_input_tokens;
  }

  private onMessageStop(): void {
    this.emitChunk(
      { finish_reason: this.finishReason ?? "stop" },
      { usage: anthropicUsageToChat(this.anthUsage) },
    );
    this.emitDone();
    this.finishReason = this.finishReason ?? "stop";
  }
}
