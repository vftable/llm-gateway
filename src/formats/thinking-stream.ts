// Streaming thinking/reasoning parser — the cross-format state machine.
//
// Non-streaming responses can scan the whole body for closed blocks at once.
// Streaming can't: a single block may be split across many chunks (the opening
// tag itself can be split mid-tag). StreamingThinkingParser takes one content
// delta at a time and returns the content/reasoning split for it. Both the
// OpenAI chat transform (formats/openai/streaming.ts) and the Anthropic messages
// transform (formats/anthropic/streaming.ts) drive this parser, so it lives at
// the shared formats root rather than under either format.

import { stripInvisible } from "../utils";

// Regex patterns for matching opening and closing tags.
// The `antml` namespace prefix is only supported on <thinking> (Anthropic),
// not on <reasoning> or <think>.
const OPEN_TAG_RE =
  /<\s*(?:(?:antml(?:[:\s]+))?think(?:ing)?|reasoning|thinking_mode)\s*>/i;
const CLOSE_TAG_RE =
  /<\s*\/\s*(?:(?:antml(?:[:\s]+))?think(?:ing)?|reasoning|thinking_mode)\s*>/i;

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
      partialTagMatch(buffer, "<reasoning>") ||
      partialTagMatch(buffer, "<thinking_mode>")
    );
  }

  // Check if the buffer end could be the start of a closing tag.
  private partialCloseTag(buffer: string): number {
    return (
      partialTagMatch(buffer, "</thinking>") ||
      partialTagMatch(buffer, "</think>") ||
      partialTagMatch(buffer, "</reasoning>") ||
      partialTagMatch(buffer, "</reason>") ||
      partialTagMatch(buffer, "</thinking_mode>")
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

// stripInvisible re-exported for the transforms that clean chunk bytes.
export { stripInvisible };
