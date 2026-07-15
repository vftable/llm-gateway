// Chat SSE -> Anthropic Messages SSE.
//
// Chat chunks carry delta.content / delta.tool_calls / finish_reason + usage.
// We emit the Anthropic event sequence:
//   message_start -> content_block_start/delta/stop -> message_delta -> message_stop

import { Transform, type TransformCallback } from "stream";
import { SseFrameReader, parseSseData } from "../../sse/frame";
import { SYNTHETIC_THINKING_SIGNATURE } from "../../wire/anthropic";
import {
  genId,
  sanitizeToolId,
  extractReasoningText,
  FINISH_TO_STOP,
  chatUsageToAnthropic,
} from "./shared";

export class ChatToMessagesSseTransform extends Transform {
  private readonly reader = new SseFrameReader();
  private started = false;
  private finished = false;
  private nextIndex = 0;
  private textBlockOpen = false;
  private thinkingBlockOpen = false;
  private toolBlocks = new Map<number, number>(); // chat tool index -> anthropic block index
  private model: string | null;
  private lastUsage: Parameters<typeof chatUsageToAnthropic>[0] | undefined;

  constructor(model?: string | null) {
    super({ highWaterMark: 0 });
    this.model = model ?? null;
  }

  _transform(chunk: Buffer, _enc: string, cb: TransformCallback): void {
    for (const evt of this.reader.feed(chunk)) this.handleEvent(evt);
    cb();
  }

  _flush(cb: TransformCallback): void {
    const tail = this.reader.flush();
    if (tail && !this.finished) this.handleEvent(tail);
    cb();
  }

  private send(obj: { type: string } & Record<string, unknown>): void {
    // Anthropic SSE uses an `event: <type>` line plus a `data:` line. Both are
    // required — clients (e.g. Claude Code) key off the event line.
    this.push(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
  }

  private startMessage(): void {
    this.started = true;
    const u = chatUsageToAnthropic(this.lastUsage);
    this.send({
      type: "message_start",
      message: {
        id: genId("msg_"),
        type: "message",
        role: "assistant",
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: u.input_tokens,
          output_tokens: 0,
          ...(u.cache_read_input_tokens
            ? { cache_read_input_tokens: u.cache_read_input_tokens }
            : {}),
          ...(u.cache_creation_input_tokens
            ? { cache_creation_input_tokens: u.cache_creation_input_tokens }
            : {}),
        },
      },
    });
  }

  private openTextBlock(): number {
    const i = this.nextIndex++;
    this.textBlockOpen = true;
    this.send({
      type: "content_block_start",
      index: i,
      content_block: { type: "text", text: "" },
    });
    return i;
  }

  // S1: thinking block lifecycle. Reasoning arrives before content in practice.
  // Real Anthropic thinking blocks open with an empty `signature` field too
  // (not just `thinking`) — matches the live API's own content_block_start
  // shape for a not-yet-signed block.
  private openThinkingBlock(): number {
    const i = this.nextIndex++;
    this.thinkingBlockOpen = true;
    this.send({
      type: "content_block_start",
      index: i,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });
    return i;
  }

  // Real Anthropic extended-thinking streams end a thinking block with a
  // `signature_delta` event (carrying the cryptographic signature) BEFORE
  // `content_block_stop` — never inside content_block_start. This bridge is
  // synthesizing the thinking block from an OpenAI-shaped reasoning_content
  // stream, so there's no genuine signature to relay; SYNTHETIC_THINKING_SIGNATURE
  // fills the slot so the block's SHAPE matches a real one (some clients/SDKs,
  // including Anthropic's own, reject a thinking block with no signature at
  // all on echo-back). See that constant's doc comment for why this is safe:
  // stripUnsupportedThinking normalizes every thinking block — synthetic or
  // real — back to text before any request reaches a messages-speaking
  // upstream, so this placeholder never needs to be a valid signature.
  private closeThinkingBlock(): void {
    if (!this.thinkingBlockOpen) return;
    this.send({
      type: "content_block_delta",
      index: this.nextIndex - 1,
      delta: {
        type: "signature_delta",
        signature: SYNTHETIC_THINKING_SIGNATURE,
      },
    });
    this.send({ type: "content_block_stop", index: this.nextIndex - 1 });
    this.thinkingBlockOpen = false;
  }

  private handleEvent(raw: string): void {
    const dataStr = parseSseData(raw).data;
    if (!dataStr) return; // no (or empty) data line
    if (this.finished) return; // ignore trailing [DONE] / chunks after message_stop
    if (dataStr === "[DONE]") {
      if (!this.started) this.startMessage();
      this.closeThinkingBlock();
      if (this.textBlockOpen) {
        this.send({ type: "content_block_stop", index: this.nextIndex - 1 });
        this.textBlockOpen = false;
      }
      for (const idx of this.toolBlocks.values())
        this.send({ type: "content_block_stop", index: idx });
      this.toolBlocks.clear();
      this.send({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: chatUsageToAnthropic(this.lastUsage),
      });
      this.send({ type: "message_stop" });
      this.finished = true;
      return;
    }
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(dataStr);
    } catch {
      return;
    }
    if (chunk.usage && typeof chunk.usage === "object")
      this.lastUsage = chunk.usage as typeof this.lastUsage;
    if (typeof chunk.model === "string" && chunk.model)
      this.model = chunk.model;
    if (!this.started) this.startMessage();

    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    const delta = choice?.delta as Record<string, unknown> | undefined;
    if (delta) {
      // S1: reasoning_content -> thinking block (streamed before text).
      const reasoning = extractReasoningText(delta);
      if (reasoning) {
        if (this.textBlockOpen) {
          this.send({ type: "content_block_stop", index: this.nextIndex - 1 });
          this.textBlockOpen = false;
        }
        if (!this.thinkingBlockOpen) this.openThinkingBlock();
        this.send({
          type: "content_block_delta",
          index: this.nextIndex - 1,
          delta: { type: "thinking_delta", thinking: reasoning },
        });
      }
      if (typeof delta.content === "string" && delta.content) {
        this.closeThinkingBlock();
        if (!this.textBlockOpen) this.openTextBlock();
        this.send({
          type: "content_block_delta",
          index: this.nextIndex - 1,
          delta: { type: "text_delta", text: delta.content },
        });
      }
      const tcArr = delta.tool_calls as
        | Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>
        | undefined;
      if (Array.isArray(tcArr)) {
        // Close any open text/thinking block before emitting tool_use.
        this.closeThinkingBlock();
        if (this.textBlockOpen) {
          this.send({ type: "content_block_stop", index: this.nextIndex - 1 });
          this.textBlockOpen = false;
        }
        for (const tc of tcArr) {
          const ci = tc.index ?? 0;
          let blockIndex = this.toolBlocks.get(ci);
          if (blockIndex === undefined) {
            blockIndex = this.nextIndex++;
            this.toolBlocks.set(ci, blockIndex);
            this.send({
              type: "content_block_start",
              index: blockIndex,
              content_block: {
                type: "tool_use",
                id: sanitizeToolId(tc.id, `toolu_${ci}`),
                name: tc.function?.name ?? "",
                input: {},
              },
            });
          } else if (tc.function?.name) {
            // name arriving late (rare) — ignore
          }
          if (tc.function?.arguments) {
            this.send({
              type: "content_block_delta",
              index: blockIndex,
              delta: {
                type: "input_json_delta",
                partial_json: tc.function.arguments,
              },
            });
          }
        }
      }
    }

    const finish = choice?.finish_reason as string | undefined;
    if (finish) {
      this.closeThinkingBlock();
      if (this.textBlockOpen) {
        this.send({ type: "content_block_stop", index: this.nextIndex - 1 });
        this.textBlockOpen = false;
      }
      for (const idx of this.toolBlocks.values())
        this.send({ type: "content_block_stop", index: idx });
      this.toolBlocks.clear();
      // S2: fold OpenAI usage into Anthropic shape (cache split preserved).
      // Use lastUsage as fallback — some providers send usage on a separate
      // chunk before finish_reason, or on a usage-only chunk after it.
      const anthUsage = chatUsageToAnthropic(
        (chunk.usage as Parameters<typeof chatUsageToAnthropic>[0]) ??
          this.lastUsage,
      );
      this.send({
        type: "message_delta",
        delta: {
          stop_reason: FINISH_TO_STOP[finish] ?? "end_turn",
          stop_sequence: null,
        },
        usage: anthUsage,
      });
      this.send({ type: "message_stop" });
      this.finished = true;
    }
  }
}
