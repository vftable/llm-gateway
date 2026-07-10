// OpenAI chat-completions SSE thinking transform.
//
// Sits on the `/v1/chat/completions` SSE byte stream, parses events at `\n\n`
// boundaries, runs each chunk's `delta.content` through the shared
// StreamingThinkingParser, and re-emits the event with `delta.content` +
// `delta.reasoning_content` set appropriately.
//
// Lives alongside messages-stream.ts (the Anthropic-format counterpart) in
// formats/thinking/ since both are same-format inline-tag extraction
// transforms built on the shared StreamingThinkingParser (./stream.ts).

import { Transform, type TransformCallback } from "stream";
import { StreamingThinkingParser } from "./stream";
import { SseFrameReader } from "../sse/frame";

// Minimal view of a chat-completion stream chunk — only the bits we touch.
interface ChatCompletionChunk {
  choices?: Array<{
    index?: number;
    delta?: {
      content?: string;
      role?: string;
      tool_calls?: unknown;
      [k: string]: unknown;
    };
    finish_reason?: string | null;
  }>;
  [k: string]: unknown;
}

// Transform stream for `/v1/chat/completions` SSE: rewrites each
// `delta.content` so text inside thinking/reasoning blocks is moved into
// `delta.reasoning_content`. Buffers bytes between `\n\n` event boundaries so
// we never split a UTF-8 multi-byte sequence.
export class SseThinkingTransform extends Transform {
  private readonly reader = new SseFrameReader();
  private readonly parser = new StreamingThinkingParser();

  constructor() {
    // We push strings; default encoding handles UTF-8 on the way out.
    super();
  }

  _transform(
    chunk: Buffer,
    _encoding: string,
    callback: TransformCallback,
  ): void {
    for (const raw of this.reader.feed(chunk)) {
      const out = this.processEvent(raw);
      if (out !== null) this.push(out);
    }
    callback();
  }

  _flush(callback: TransformCallback): void {
    // Flush any half-event the upstream left us.
    const frameTail = this.reader.flush();
    if (frameTail !== null) {
      const out = this.processEvent(frameTail);
      if (out !== null) this.push(out);
    }
    // If the parser is still holding bytes for a partial tag, emit them as a
    // synthesized final chunk so the client sees the trailing text.
    const tail = this.parser.flush();
    if (tail.content || tail.reasoning) {
      const delta: Record<string, unknown> = {};
      if (tail.content) delta.content = tail.content;
      if (tail.reasoning) {
        delta.reasoning_content = tail.reasoning;
        delta.reasoning_details = tail.reasoningDetails;
      }
      const synthetic: ChatCompletionChunk = {
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: null }],
      };
      this.push(`data: ${JSON.stringify(synthetic)}\n\n`);
    }
    callback();
  }

  private processEvent(event: string): string | null {
    const lines = event.split("\n");
    const dataLines: string[] = [];
    const otherLines: string[] = [];

    for (const line of lines) {
      // SSE allows "data:" or "data: " (with a single leading space). Both
      // are valid; trim only that one optional space.
      if (line.startsWith("data:")) {
        const payload = line.slice(5);
        dataLines.push(payload.startsWith(" ") ? payload.slice(1) : payload);
      } else if (line.length > 0) {
        otherLines.push(line);
      }
    }

    if (dataLines.length === 0) {
      // No data lines: heartbeat, comment, or out-of-band event — pass through.
      return event + "\n\n";
    }

    const data = dataLines.join("\n");
    if (data === "[DONE]") {
      // Stream terminator — emit unchanged.
      return event + "\n\n";
    }

    let chunk: ChatCompletionChunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      // Non-JSON data — pass through unchanged rather than corrupting the stream.
      return event + "\n\n";
    }

    const transformed = this.transformChunk(chunk);
    if (transformed === null) return null; // drop this event entirely

    // Rebuild the event preserving any other SSE fields the upstream set.
    const newData = JSON.stringify(transformed);
    const prefix = otherLines.length > 0 ? otherLines.join("\n") + "\n" : "";
    return prefix + "data: " + newData + "\n\n";
  }

  private transformChunk(
    chunk: ChatCompletionChunk,
  ): ChatCompletionChunk | null {
    if (!Array.isArray(chunk.choices)) return chunk;

    for (const choice of chunk.choices) {
      const delta = choice && choice.delta;
      if (!delta) continue;
      const content = delta.content;
      if (typeof content !== "string") continue;

      const {
        content: c,
        reasoning: r,
        reasoningDetails: rd,
      } = this.parser.feed(content);
      delta.content = c;
      if (r) {
        delta.reasoning_content = r;
      } else if ("reasoning_content" in delta) {
        delete delta.reasoning_content;
      }
      if (rd && rd.length > 0) {
        delta.reasoning_details = rd;
      } else if ("reasoning_details" in delta) {
        delete delta.reasoning_details;
      }
    }
    return chunk;
  }
}
