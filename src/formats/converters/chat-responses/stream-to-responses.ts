// Streaming bridge: Chat Completions SSE -> Responses SSE.
//
// Converts a streaming /v1/chat/completions SSE response into /v1/responses
// SSE events. Handles reasoning (from <thinking> conversion), tool calls, and
// content deltas. Each upstream chunk is translated and emitted immediately —
// no buffering beyond what's needed for JSON parsing.
//
// Responses SSE event types emitted:
//   response.created, response.in_progress, response.output_item.added,
//   response.content_block.started, response.content_block.delta,
//   response.content_block.stop, response.output_item.done,
//   response.completed

import { Transform, type TransformCallback } from "stream";
import { SseFrameReader } from "../../sse/frame";
import type { ResponsesStreamEvent } from "../../wire";
import { genId, FINISH_TO_STATUS, type ChatCompletionChunk } from "./shared";

export class StreamingResponsesBridgeTransform extends Transform {
  private readonly reader = new SseFrameReader();
  private responseId: string | null = null;
  private created: number | null = null;
  private model: string | null = null;
  private systemFingerprint: string | null = null;
  private outputItemCount = 0;
  private currentBlockIndex = 0;
  private reasoningBlockIndex = -1;
  private reasoningItemId: string | null = null;
  private reasoningOutputIndex = -1;
  private textBlockIndex = -1;
  private textItemId: string | null = null;
  private textOutputIndex = -1;
  private toolCallBlocks = new Map<
    number,
    {
      index: string;
      name: string;
      blockIndex: number;
      itemId: string;
      outputIndex: number;
    }
  >();
  private finished = false;
  // Track all output items for correct type/id in output_item.done events
  private outputItems: Array<{ type: string; id: string }> = [];

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
    // Emit response.completed if not already done
    if (!this.finished) {
      this.closeOpenBlocks();
      this.pushSse({
        type: "response.completed",
        response: this.buildResponse("completed"),
      });
      this.finished = true;
    }
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
    if (!dataStr || dataStr === "[DONE]") {
      if (dataStr === "[DONE]" && !this.finished) {
        this.closeOpenBlocks();
        this.pushSse({
          type: "response.completed",
          response: this.buildResponse("completed"),
        });
        this.finished = true;
      }
      return;
    }

    let chunk: ChatCompletionChunk;
    try {
      chunk = JSON.parse(dataStr);
    } catch {
      return; // non-JSON, skip
    }

    this.translateChunk(chunk);
  }

  private translateChunk(chunk: ChatCompletionChunk): void {
    // First chunk: emit response.created + response.in_progress
    if (!this.responseId) {
      this.responseId = chunk.id || genId("resp_");
      this.created = chunk.created || Math.floor(Date.now() / 1000);
      this.model = chunk.model || null;
      this.systemFingerprint = chunk.system_fingerprint || null;

      this.pushSse({
        type: "response.created",
        response: this.buildResponse("in_progress"),
      });
      this.pushSse({
        type: "response.in_progress",
        response: this.buildResponse("in_progress"),
      });
    }

    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta;
    if (!delta) return;

    // Handle role delta (first chunk often has role only)
    if (delta.role) {
      // Role is set on the message, we'll handle it when content arrives
    }

    // Handle reasoning (from <thinking> conversion) - check all field names
    if (
      delta.reasoning ||
      delta.reasoning_content ||
      delta.reasoning_details?.length
    ) {
      this.handleReasoningDelta(delta);
    }

    // Handle content
    if (typeof delta.content === "string" && delta.content) {
      this.handleContentDelta(delta.content);
    }

    // Handle tool calls
    if (delta.tool_calls?.length) {
      this.handleToolCallDelta(delta.tool_calls);
    }

    // Handle finish
    if (choice.finish_reason) {
      this.handleFinish(choice.finish_reason, chunk.usage);
    }
  }

  private handleReasoningDelta(delta: {
    reasoning?: string;
    reasoning_content?: string;
    reasoning_details?: Array<{ type: string; text: string }>;
  }): void {
    const text =
      delta.reasoning ||
      delta.reasoning_content ||
      delta.reasoning_details?.map((d) => d.text).join("") ||
      "";
    if (!text) return;

    // Open reasoning block if not already open
    if (this.reasoningBlockIndex === -1) {
      this.reasoningBlockIndex = this.currentBlockIndex++;
      this.outputItemCount++;
      this.reasoningItemId = genId("rs_");
      this.reasoningOutputIndex = this.outputItemCount - 1;
      this.outputItems.push({ type: "reasoning", id: this.reasoningItemId });
      this.pushSse({
        type: "response.output_item.added",
        output_index: this.reasoningOutputIndex,
        item: {
          type: "reasoning",
          id: this.reasoningItemId,
          summary: [],
        },
      });
      this.pushSse({
        type: "response.content_part.added",
        item_id: this.reasoningItemId,
        output_index: this.reasoningOutputIndex,
        content_index: 0,
        part: { type: "summary_text", text: "" },
      });
    }

    this.pushSse({
      type: "response.reasoning_summary_text.delta",
      item_id: this.reasoningItemId,
      output_index: this.reasoningOutputIndex,
      summary_index: 0,
      delta: text,
    });
  }

  private handleContentDelta(content: string): void {
    // Close reasoning block if open
    if (this.reasoningBlockIndex !== -1) {
      this.pushSse({
        type: "response.reasoning_summary_text.done",
        item_id: this.reasoningItemId,
        output_index: this.reasoningOutputIndex,
        summary_index: 0,
      });
      this.pushSse({
        type: "response.content_part.done",
        item_id: this.reasoningItemId,
        output_index: this.reasoningOutputIndex,
        content_index: 0,
        part: { type: "summary_text", text: "" },
      });
      this.reasoningBlockIndex = -1;
      this.reasoningItemId = null;
      this.reasoningOutputIndex = -1;
    }

    // Open text block if not already open
    if (this.textBlockIndex === -1) {
      this.textBlockIndex = this.currentBlockIndex++;
      this.outputItemCount++;
      this.textItemId = genId("msg_");
      this.textOutputIndex = this.outputItemCount - 1;
      this.outputItems.push({ type: "message", id: this.textItemId });
      this.pushSse({
        type: "response.output_item.added",
        output_index: this.textOutputIndex,
        item: {
          type: "message",
          id: this.textItemId,
          role: "assistant",
          content: [],
        },
      });
      this.pushSse({
        type: "response.content_part.added",
        item_id: this.textItemId,
        output_index: this.textOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: "" },
      });
    }

    // Emit content delta using correct OpenAI event type
    this.pushSse({
      type: "response.output_text.delta",
      item_id: this.textItemId,
      output_index: this.textOutputIndex,
      content_index: 0,
      delta: content,
    });
  }

  private handleToolCallDelta(
    toolCalls: Array<{
      index?: number;
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>,
  ): void {
    for (const tc of toolCalls) {
      const tcIndex = tc.index ?? 0;
      let block = this.toolCallBlocks.get(tcIndex);

      if (!block) {
        // New tool call
        const blockIndex = this.currentBlockIndex++;
        const itemId = genId("fc_");
        const outputIndex = this.outputItemCount;
        this.outputItemCount++;
        block = {
          index: tc.id || genId("call_"),
          name: tc.function?.name || "",
          blockIndex,
          itemId,
          outputIndex,
        };
        this.toolCallBlocks.set(tcIndex, block);
        this.outputItems.push({ type: "function_call", id: itemId });

        this.pushSse({
          type: "response.output_item.added",
          output_index: outputIndex,
          item: {
            type: "function_call",
            id: itemId,
            call_id: block.index,
            name: block.name,
            arguments: "",
          },
        });
      }

      // Emit argument delta using correct OpenAI event type
      if (tc.function?.arguments) {
        this.pushSse({
          type: "response.function_call_arguments.delta",
          item_id: block.itemId,
          output_index: block.outputIndex,
          delta: tc.function.arguments,
        });
      }
    }
  }

  private closeOpenBlocks(): void {
    // Close any open text block
    if (this.textBlockIndex !== -1) {
      this.pushSse({
        type: "response.content_part.done",
        item_id: this.textItemId,
        output_index: this.textOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: "" },
      });
      this.pushSse({
        type: "response.text.done",
        item_id: this.textItemId,
        output_index: this.textOutputIndex,
        content_index: 0,
      });
      this.textBlockIndex = -1;
      this.textItemId = null;
      this.textOutputIndex = -1;
    }

    // Close any open reasoning block
    if (this.reasoningBlockIndex !== -1) {
      this.pushSse({
        type: "response.reasoning_summary_text.done",
        item_id: this.reasoningItemId,
        output_index: this.reasoningOutputIndex,
        summary_index: 0,
      });
      this.pushSse({
        type: "response.content_part.done",
        item_id: this.reasoningItemId,
        output_index: this.reasoningOutputIndex,
        content_index: 0,
        part: { type: "summary_text", text: "" },
      });
      this.reasoningBlockIndex = -1;
      this.reasoningItemId = null;
      this.reasoningOutputIndex = -1;
    }

    // Close any open tool call blocks
    for (const [, block] of this.toolCallBlocks) {
      this.pushSse({
        type: "response.function_call_arguments.done",
        item_id: block.itemId,
        output_index: block.outputIndex,
      });
    }
    this.toolCallBlocks.clear();
  }

  private handleFinish(
    finishReason: string,
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      prompt_tokens_details?: unknown;
      completion_tokens_details?: unknown;
    },
  ): void {
    this.closeOpenBlocks();

    // Mark output items as done
    for (let i = 0; i < this.outputItemCount; i++) {
      this.pushSse({
        type: "response.output_item.done",
        output_index: i,
        item: this.buildOutputItem(i),
      });
    }

    // Emit response.completed
    const status = FINISH_TO_STATUS[finishReason] || "completed";
    const response = this.buildResponse(status);
    if (usage) {
      response.usage = {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
        input_tokens_details: usage.prompt_tokens_details,
        output_tokens_details: usage.completion_tokens_details,
      };
    }
    this.pushSse({ type: "response.completed", response });
    this.finished = true;
  }

  private buildResponse(status: string): Record<string, unknown> {
    return {
      id: this.responseId || genId("resp_"),
      object: "response",
      created_at: this.created || Math.floor(Date.now() / 1000),
      model: this.model,
      status,
      output: [],
      system_fingerprint: this.systemFingerprint,
    };
  }

  private buildOutputItem(index: number): Record<string, unknown> {
    const item = this.outputItems[index];
    if (item) {
      return { type: item.type, id: item.id, status: "completed" };
    }
    // Fallback shouldn't happen, but handle gracefully
    return { type: "message", id: genId("msg_"), status: "completed" };
  }

  private pushSse(event: ResponsesStreamEvent): void {
    this.push(`data: ${JSON.stringify(event)}\n\n`);
  }
}
