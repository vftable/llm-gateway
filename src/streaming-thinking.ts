// Streaming thinking/reasoning conversion for SSE responses.
//
// Non-streaming responses can scan the whole body for closed blocks at once.
// Streaming can't: a single block may be split across many chunks (the
// opening tag itself can be split mid-tag). This module ships two pieces
// that together solve that:
//
//   1. StreamingThinkingParser — a state machine that takes one content delta
//      at a time and returns the content/reasoning split for it.
//
//   2. SseThinkingTransform — a Node stream.Transform that sits on the SSE
//      byte stream, parses events at `\n\n` boundaries, runs each chat-
//      completion chunk's `delta.content` through the parser, and re-emits
//      the event with `delta.content` + `delta.reasoning_content` set
//      appropriately.

import { Transform, type TransformCallback } from "stream";
import { stripInvisible } from "./utils";

// Regex patterns for matching opening and closing tags.
// The `antml` namespace prefix is only supported on <thinking> (Anthropic),
// not on <reasoning> or <think>.
const OPEN_TAG_RE = /<\s*(?:(?:antml(?:[:\s]+))?think(?:ing)?|reasoning)\s*>/i;
const CLOSE_TAG_RE =
  /<\s*\/\s*(?:(?:antml(?:[:\s]+))?think(?:ing)?|reasoning)\s*>/i;

// Matches triple-backtick fenced code block markers (```).
const FENCE_RE = /`{3}/;

export interface ReasoningDetailEntry {
  type: "reasoning.text";
  text: string;
  format: "unknown";
  index: number;
}

export interface ThinkingDelta {
  /** Text to forward as `delta.content`. */
  content: string;
  /** Text to forward as `delta.reasoning_content` (concatenation across blocks). */
  reasoning: string;
  /** Incremental reasoning_details entries, one per emitted text segment.
   *  Multiple entries in a single delta mean the chunk span block boundaries.
   *  Each carries its source block's `index` so a client can group deltas. */
  reasoningDetails: ReasoningDetailEntry[];
  /** Number of new thinking blocks that started in this feed call.
   *  Used by the Anthropic transform to close/open blocks correctly. */
  blockStarts: number;
}

// Longest suffix of `buffer` that is a non-empty proper prefix of `tag`.
// Returns 0 if no such suffix.
function partialTagMatch(buffer: string, tag: string): number {
  const maxK = Math.min(buffer.length, tag.length - 1);
  for (let k = maxK; k >= 1; k--) {
    if (buffer.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

export class StreamingThinkingParser {
  private state: "content" | "thinking" = "content";
  private carry = "";
  private blockIndex = -1;
  private stripLeading = false;
  private inCodeBlock = false;

  // Check if the buffer end could be the start of an opening tag.
  private partialOpenTag(buffer: string): number {
    return (
      partialTagMatch(buffer, "<thinking>") ||
      partialTagMatch(buffer, "<think>") ||
      partialTagMatch(buffer, "<reasoning>")
    );
  }

  // Check if the buffer end could be the start of a closing tag.
  private partialCloseTag(buffer: string): number {
    return (
      partialTagMatch(buffer, "</thinking>") ||
      partialTagMatch(buffer, "") ||
      partialTagMatch(buffer, "</reasoning>") ||
      partialTagMatch(buffer, "</reason>")
    );
  }

  feed(input: string): ThinkingDelta {
    if (!input)
      return {
        content: "",
        reasoning: "",
        reasoningDetails: [],
        blockStarts: 0,
      };

    let buffer = this.carry + input;
    this.carry = "";

    let contentOut = "";
    let reasoningOut = "";
    const details: ReasoningDetailEntry[] = [];
    let blockStarts = 0;

    // Add `text` to the reasoning output, applying the per-block leading
    // whitespace strip. Emits a reasoning_details entry for the segment so
    // clients that prefer the structured form stay in sync with the
    // reasoning_content string form.
    const emitReasoning = (text: string) => {
      if (!text) return;
      if (this.stripLeading) {
        text = text.replace(/^\s+/, "");
        if (!text) return;
        this.stripLeading = false;
      }
      reasoningOut += text;
      details.push({
        type: "reasoning.text",
        text,
        format: "unknown",
        index: this.blockIndex,
      });
    };

    // Bound the loop defensively; in practice it runs once or twice per call.
    let safety = 64;
    while (buffer && safety-- > 0) {
      if (this.state === "content") {
        // Inside a fenced code block: skip thinking tag matching entirely.
        if (this.inCodeBlock) {
          const fence = FENCE_RE.exec(buffer);
          if (fence && fence.index !== undefined) {
            // Emit everything up to and including the closing fence.
            contentOut += buffer.slice(0, fence.index + fence[0].length);
            buffer = buffer.slice(fence.index + fence[0].length);
            this.inCodeBlock = false;
            continue;
          }
          contentOut += buffer;
          buffer = "";
          continue;
        }

        // Outside code block: check for opening fence first.
        const fence = FENCE_RE.exec(buffer);
        if (fence && fence.index !== undefined) {
          // Emit text before the fence, then the fence itself, then toggle.
          contentOut += buffer.slice(0, fence.index + fence[0].length);
          buffer = buffer.slice(fence.index + fence[0].length);
          this.inCodeBlock = true;
          continue;
        }

        const m = OPEN_TAG_RE.exec(buffer);
        if (m && m.index !== undefined) {
          contentOut += buffer.slice(0, m.index);
          buffer = buffer.slice(m.index + m[0].length);
          this.state = "thinking";
          this.blockIndex += 1;
          this.stripLeading = true;
          blockStarts += 1;
          continue;
        }
        // No full tag. Hold back any trailing bytes that could be the start
        // of one; emit the rest now.
        const partial = this.partialOpenTag(buffer);
        if (partial > 0) {
          contentOut += buffer.slice(0, buffer.length - partial);
          this.carry = buffer.slice(buffer.length - partial);
        } else {
          contentOut += buffer;
        }
        buffer = "";
      } else {
        const m = CLOSE_TAG_RE.exec(buffer);
        if (m && m.index !== undefined) {
          emitReasoning(buffer.slice(0, m.index));
          buffer = buffer.slice(m.index + m[0].length);
          this.state = "content";
          continue;
        }
        const partial = this.partialCloseTag(buffer);
        if (partial > 0) {
          emitReasoning(buffer.slice(0, buffer.length - partial));
          this.carry = buffer.slice(buffer.length - partial);
        } else {
          emitReasoning(buffer);
        }
        buffer = "";
      }
    }

    return {
      content: contentOut,
      reasoning: reasoningOut,
      reasoningDetails: details,
      blockStarts,
    };
  }

  // End of stream: emit any held-over carry as best-effort content/reasoning.
  // Partial closing tags (e.g. trailing `</` or `</th`) inside a thinking
  // block are discarded — they are incomplete markup, not real reasoning.
  flush(): ThinkingDelta {
    if (!this.carry)
      return {
        content: "",
        reasoning: "",
        reasoningDetails: [],
        blockStarts: 0,
      };
    let carry = this.carry;
    this.carry = "";
    if (this.state === "content") {
      return {
        content: carry,
        reasoning: "",
        reasoningDetails: [],
        blockStarts: 0,
      };
    }
    // Thinking state — emit carry as a final reasoning chunk, but first
    // strip any partial closing tags (e.g. `</`, `</th`, `</thinki`).
    const partial = this.partialCloseTag(carry);
    if (partial > 0) {
      carry = carry.slice(0, carry.length - partial);
    }
    let text = carry;
    if (this.stripLeading) {
      text = text.replace(/^\s+/, "");
    }
    if (!text)
      return {
        content: "",
        reasoning: "",
        reasoningDetails: [],
        blockStarts: 0,
      };
    return {
      content: "",
      reasoning: text,
      reasoningDetails: [
        {
          type: "reasoning.text",
          text,
          format: "unknown",
          index: this.blockIndex,
        },
      ],
      blockStarts: 0,
    };
  }
}

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
  private buffer = Buffer.alloc(0);
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
    const cleaned = Buffer.from(stripInvisible(chunk.toString("utf8")), "utf8");
    this.buffer = Buffer.concat([this.buffer, cleaned]);

    // Process every complete SSE event (terminated by \n\n).
    while (true) {
      const idx = this.buffer.indexOf("\n\n");
      if (idx === -1) break;
      const eventBytes = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const out = this.processEvent(eventBytes.toString("utf8"));
      if (out !== null) this.push(out);
    }
    callback();
  }

  _flush(callback: TransformCallback): void {
    // Flush any half-event the upstream left us.
    if (this.buffer.length > 0) {
      const out = this.processEvent(this.buffer.toString("utf8"));
      this.buffer = Buffer.alloc(0);
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
