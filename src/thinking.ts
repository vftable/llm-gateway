// Extract <thinking>/<reasoning> blocks from upstream responses and convert
// them into OpenAI-style reasoning fields.
//
// Supports:
//   <thinking>...</thinking>  (also <antml:thinking>, < antml thinking >)
//   <think>...
//   <reasoning>...</reasoning>
//
// Non-streaming only. Streaming is handled by streaming-thinking.ts.

// Matches a full thinking/reasoning block.  The `antml` namespace prefix
// is only supported on <thinking> (Anthropic models), not on <reasoning>
// or <think>.  Case-insensitive, DOTALL.  Non-greedy so multiple
// consecutive blocks are captured separately.
const THINKING_RE =
  /<\s*(?:(?:antml(?:[:\s]+))?think(?:ing)?|reasoning)\s*>([\s\S]*?)<\s*\/\s*(?:(?:antml(?:[:\s]+))?think(?:ing)?|reasoning)\s*>/gi;

// Matches an unclosed opening thinking/reasoning tag.  Used after
// THINKING_RE has stripped all closed blocks to clean up raw tags that
// models leave behind when they get "stuck".
const UNCLOSED_OPEN_TAG_RE =
  /<\s*(?:(?:antml(?:[:\s]+))?think(?:ing)?|reasoning)\s*>/gi;

// A reasoning_details entry produced by the gateway. OpenAI-style shape.
export interface ReasoningDetailEntry {
  type: "reasoning.text";
  text: string;
  format: "unknown";
  index: number;
}

// --- Code block helpers ---------------------------------------------------
// Fenced code blocks (```) and inline code spans (`...`) protect their
// contents from thinking extraction.

// Returns an array of [start, end) byte-offset ranges for fenced code blocks
// and inline code spans (single or double backticks).
function codeBlockRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let inside = false;
  let fenceStart = 0;
  let i = 0;

  while (i < text.length) {
    // Always check triple backticks first — they are fence delimiters
    // whether we're inside a fence or not.
    if (
      text[i] === "`" &&
      i + 2 < text.length &&
      text[i + 1] === "`" &&
      text[i + 2] === "`"
    ) {
      if (!inside) {
        fenceStart = i;
        inside = true;
      } else {
        ranges.push([fenceStart, i + 3]);
        inside = false;
      }
      i += 3;
      continue;
    }

    // Inline code spans: only when not inside a fenced block.
    if (!inside && text[i] === "`") {
      let run = 1;
      while (i + run < text.length && text[i + run] === "`") run++;
      const spanStart = i;
      let j = i + run;
      while (j < text.length) {
        if (text[j] === "`") {
          let closeRun = 0;
          while (j + closeRun < text.length && text[j + closeRun] === "`")
            closeRun++;
          if (closeRun === run) {
            ranges.push([spanStart, j + closeRun]);
            i = j + closeRun;
            break;
          }
          j += closeRun;
        } else {
          j++;
        }
      }
      if (i === spanStart) i += run;
      continue;
    }

    i++;
  }

  // Unclosed fence: treat rest of text as inside a code block.
  if (inside) ranges.push([fenceStart, text.length]);
  return ranges;
}

// Check if `pos` falls inside any of the given [start, end) ranges.
function isInsideRange(pos: number, ranges: Array<[number, number]>): boolean {
  for (const [start, end] of ranges) {
    if (pos >= start && pos < end) return true;
  }
  return false;
}

// Fields the gateway attaches to a chat message after <thinking> extraction.
interface ThinkingFields {
  reasoning?: string;
  reasoning_details?: ReasoningDetailEntry[];
  reasoning_content?: string;
}

// Minimal local view of a chat-completions body. We intentionally don't pull
// in the full OpenAI SDK type here because we mutate it heavily and add
// gateway-specific fields; keeping this self-contained makes the transform
// easy to follow.
interface ChatCompletionBody {
  choices?: Array<{
    message?: ChatMessage;
  }>;
  [k: string]: unknown;
}

interface ChatMessage extends ThinkingFields {
  role?: string;
  content?: string | Array<ContentPart | unknown>;
  [k: string]: unknown;
}

interface ContentPart {
  type: string;
  text?: string;
  image_url?: { url: string; detail?: string };
}

// Minimal local view of a /v1/responses body.
interface ResponsesBody {
  output?: Array<ResponsesOutputItem | unknown>;
  [k: string]: unknown;
}

interface ResponsesOutputItem {
  type: string;
  role?: string;
  content?: Array<ResponsesContentPart | unknown>;
  [k: string]: unknown;
}

interface ResponsesContentPart {
  type?: string;
  text?: string;
  output?: string;
  [k: string]: unknown;
}

// Minimal local view of an Anthropic /v1/messages body.
interface AnthropicMessageBody {
  content?: Array<AnthropicContentBlock | unknown>;
  [k: string]: unknown;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  [k: string]: unknown;
}

export class ThinkingConverter {
  // Matches every <thinking>/<reasoning> body in `text`, in order. Returns [] if none.
  // Leading/trailing whitespace is stripped from each block so a model that
  // emits `<thinking>\n  let me think  \n</thinking>` yields "let me think".
  // Thinking tags inside fenced code blocks (```) are ignored.
  parseThinking(text?: string): string[] {
    if (typeof text !== "string") return [];
    const ranges = codeBlockRanges(text);
    const blocks: string[] = [];
    const re = new RegExp(THINKING_RE.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (isInsideRange(m.index, ranges)) continue;
      blocks.push(m[1].replace(/^\s+/, "").replace(/\s+$/, ""));
    }
    return blocks;
  }

  // Remove every thinking/reasoning block from `text` and trim the
  // leftover whitespace so the answer doesn't start with a blank line.
  // Also strips unclosed opening tags that models leave behind when they
  // get "stuck" — preventing raw <thinking>/<reasoning> tags from leaking
  // into the displayed content.
  // Thinking tags inside fenced code blocks (```) are preserved.
  stripThinking(text?: string): string {
    if (typeof text !== "string") return text as unknown as string;
    const ranges = codeBlockRanges(text);
    // Build a version of THINKING_RE that skips matches inside code blocks.
    const re = new RegExp(THINKING_RE.source, "gi");
    const stripped = text.replace(re, (match, _body, offset) => {
      if (isInsideRange(offset, ranges)) return match;
      return "";
    });
    return stripped
      .replace(UNCLOSED_OPEN_TAG_RE, "")
      .replace(/^\n+/, "")
      .replace(/\s+$/, "");
  }

  // Build the OpenAI-shaped reasoning_details array: one entry per block,
  // in order. `index` mirrors the array position so a client can correlate
  // entries across streaming deltas later.
  buildReasoningDetails(blocks: string[]): ReasoningDetailEntry[] {
    return blocks.map((text, index) => ({
      type: "reasoning.text",
      text,
      format: "unknown",
      index,
    }));
  }

  // Pull every <thinking>/<reasoning> block out of a string, return
  // [keptContent, blocks].  If the string had no thinking, returns
  // [original, []] untouched.  Also strips unclosed opening tags that
  // models leave behind when they get "stuck" in a thinking block.
  private splitThinking(text: string): [string, string[]] {
    const blocks = this.parseThinking(text);
    if (!blocks.length) {
      // No closed blocks. Strip any unclosed opening tags so raw
      // <thinking>/<reasoning> tags don't leak into the output.
      const cleaned = text.replace(UNCLOSED_OPEN_TAG_RE, "");
      if (cleaned !== text) {
        return [cleaned.replace(/^\n+/, "").replace(/\s+$/, ""), []];
      }
      return [text, []];
    }
    return [this.stripThinking(text), blocks];
  }

  // --- /v1/chat/completions ------------------------------------------------
  // Each choice.message gets:
  //   - content with thinking blocks stripped
  //   - reasoning:        first block's text (string)
  //   - reasoning_details: every block, OpenAI-shaped
  // Mutates `body` in place. Returns `body` if anything changed, else null
  // (so the caller can pass the original bytes through untouched).
  applyToChatCompletion(body: ChatCompletionBody): ChatCompletionBody | null {
    if (!body || !Array.isArray(body.choices)) return null;
    let touched = false;
    for (const choice of body.choices) {
      const msg = choice && choice.message;
      if (!msg) continue;

      let blocks: string[] = [];

      // Plain-string content (the common case).
      if (typeof msg.content === "string") {
        const [kept, b] = this.splitThinking(msg.content);
        if (b.length) {
          msg.content = kept;
          blocks = blocks.concat(b);
        } else if (kept !== msg.content) {
          // No closed blocks, but unclosed opening tags were stripped.
          // Update content so raw <thinking>/<reasoning> tags don't leak through.
          msg.content = kept;
          touched = true;
        }
      } else if (Array.isArray(msg.content)) {
        // Multimodal / content-parts: scan each text part in place.
        for (const part of msg.content) {
          if (this.isTextPart(part)) {
            const [kept, b] = this.splitThinking(part.text!);
            if (b.length) {
              part.text = kept;
              blocks = blocks.concat(b);
            } else if (kept !== part.text) {
              part.text = kept;
              touched = true;
            }
          }
        }
      }

      if (!blocks.length) continue;

      // If the upstream already supplied reasoning_content, fold it in as the
      // leading block so nothing is lost — but don't duplicate identical text.
      if (typeof msg.reasoning_content === "string" && msg.reasoning_content) {
        if (blocks[0] !== msg.reasoning_content) {
          blocks.unshift(msg.reasoning_content);
        }
        delete msg.reasoning_content;
      }

      msg.reasoning = blocks[0];
      msg.reasoning_details = this.buildReasoningDetails(blocks);
      touched = true;
    }
    return touched ? body : null;
  }

  private isTextPart(part: unknown): part is ContentPart {
    return (
      !!part &&
      typeof part === "object" &&
      (part as ContentPart).type === "text" &&
      typeof (part as ContentPart).text === "string"
    );
  }

  // --- /v1/responses -------------------------------------------------------
  // The Responses API expresses reasoning as `output[]` items of
  // { type: 'reasoning', summary: [...] }, preceding the message item.
  // We also mirror the parsed reasoning as top-level `reasoning` (first block)
  // and `reasoning_details` (every block) for direct field-name compatibility.
  applyToResponse(body: ResponsesBody): ResponsesBody | null {
    if (!body || typeof body !== "object") return null;
    if (!Array.isArray(body.output)) return null;

    let allBlocks: string[] = [];
    let touched = false;

    for (const itemRaw of body.output) {
      if (!itemRaw || typeof itemRaw !== "object") continue;
      const item = itemRaw as ResponsesOutputItem;
      if (item.type !== "message" || !Array.isArray(item.content)) continue;
      for (const partRaw of item.content) {
        if (!partRaw || typeof partRaw !== "object") continue;
        const part = partRaw as ResponsesContentPart;
        const textField =
          typeof part.text === "string"
            ? "text"
            : typeof part.output === "string"
              ? "output"
              : null;
        if (!textField) continue;
        const original = (part as Record<string, string>)[textField];
        const [kept, blocks] = this.splitThinking(original);
        if (blocks.length) {
          (part as Record<string, string>)[textField] = kept;
          allBlocks = allBlocks.concat(blocks);
          touched = true;
        } else if (kept !== original) {
          (part as Record<string, string>)[textField] = kept;
          touched = true;
        }
      }
    }

    if (!touched) return null;

    // Prepend reasoning output items, one per block, ahead of the message.
    const reasoningItems: ResponsesOutputItem[] = allBlocks.map((text, i) => ({
      type: "reasoning",
      id: `rs_thinking_${i}`,
      summary: [{ type: "summary_text", text }],
      status: "completed",
    }));
    body.output = [...reasoningItems, ...body.output];

    // Convenience top-level fields (matches /v1/chat/completions naming).
    (body as { reasoning?: string }).reasoning = allBlocks[0];
    (body as { reasoning_details?: ReasoningDetailEntry[] }).reasoning_details =
      this.buildReasoningDetails(allBlocks);

    return body;
  }

  // --- /v1/messages (Anthropic) ------------------------------------------
  // Some upstream models emit <thinking> blocks inline inside a text content
  // block. This method splits those out into proper Anthropic thinking
  // content blocks and strips the tags from the text.
  // Mutates `body` in place. Returns `body` if anything changed, else null.
  applyToAnthropicMessage(
    body: AnthropicMessageBody,
  ): AnthropicMessageBody | null {
    if (!body || typeof body !== "object") return null;
    if (!Array.isArray(body.content)) return null;

    let touched = false;
    const newContent: Array<AnthropicContentBlock> = [];

    for (const block of body.content) {
      if (!block || typeof block !== "object") {
        newContent.push(block as AnthropicContentBlock);
        continue;
      }
      const b = block as AnthropicContentBlock;
      if (b.type !== "text" || typeof b.text !== "string") {
        newContent.push(b);
        continue;
      }

      const blocks = this.parseThinking(b.text);
      if (!blocks.length) {
        // No closed blocks — strip unclosed opening tags so raw
        // <thinking>/<reasoning> tags don't leak into the output.
        const cleaned = b.text.replace(UNCLOSED_OPEN_TAG_RE, "");
        if (cleaned !== b.text) {
          b.text = cleaned.replace(/^\n+/, "").replace(/\s+$/, "");
          touched = true;
        }
        newContent.push(b);
        continue;
      }

      // Emit thinking content blocks for each extracted block.
      for (const text of blocks) {
        newContent.push({
          type: "thinking",
          thinking: text,
        } as AnthropicContentBlock);
      }

      // Strip thinking from the text; keep the text block if anything remains.
      const kept = this.stripThinking(b.text);
      if (kept) {
        newContent.push({ type: "text", text: kept } as AnthropicContentBlock);
      }

      touched = true;
    }

    if (!touched) return null;
    body.content = newContent;
    return body;
  }
}
