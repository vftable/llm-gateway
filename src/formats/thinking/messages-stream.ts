// Streaming <thinking> conversion for Anthropic Messages SSE.
//
// The gateway passes /v1/messages through to upstream (which already speaks
// the Anthropic SSE protocol). Some upstream models emit reasoning as literal
// `<thinking>...</thinking>` text inside a normal text content block instead
// of as a proper Anthropic `thinking` content block. This transform sits on
// the SSE byte stream and rewrites those inline tags into real thinking
// content blocks — without otherwise perturbing the stream.
//
// Design constraints (from the caller's requirements):
//   - Truly streaming: each upstream chunk is processed and forwarded as it
//     arrives. We never buffer the whole response.
//   - No protocol translation: this ONLY post-processes an Anthropic SSE
//     stream into another Anthropic SSE stream. It is NOT an OpenAI<->Anthropic
//     bridge.
//   - Tool calls must keep working: when a thinking block is split out and
//     inflates the block count, every subsequent content block (tool_use,
//     etc.) has its `index` remapped so the client sees contiguous indices.
//   - Robust: any error while parsing/processing a single event falls back to
//     forwarding that event's bytes verbatim, so a malformed chunk can never
//     kill the stream.
//
// Anthropic SSE format reference (per the upstream we're post-processing):
//   event: message_start
//     data: { message: { id, role, content: [], usage: {...}, ... } }
//   event: content_block_start
//     data: { index, content_block: { type: 'text'|'thinking'|'tool_use', ... } }
//   event: content_block_delta
//     data: { index, delta: { type: 'text_delta'|'thinking_delta'|'input_json_delta'|..., ... } }
//   event: content_block_stop
//     data: { index }
//   event: message_delta
//     data: { delta: { stop_reason, ... }, usage: { output_tokens } }
//   event: message_stop
//     data: { type: 'message_stop' }
//
// Lives alongside chat-stream.ts (the OpenAI Chat-format counterpart) in
// formats/thinking/ since both are same-format inline-tag extraction
// transforms built on the shared StreamingThinkingParser (./stream.ts).

import { Transform, type TransformCallback } from "stream";
import { StreamingThinkingParser } from "./stream";
import { SseFrameReader } from "../sse/frame";
import { SYNTHETIC_THINKING_SIGNATURE } from "../wire/anthropic";

type BlockType = "none" | "text" | "thinking";

interface ParsedEvent {
  event: string;
  data: Record<string, unknown> | null;
  raw: string;
}

export class AnthropicThinkingTransform extends Transform {
  private readonly reader = new SseFrameReader();
  private readonly parser = new StreamingThinkingParser();

  // --- Output-side block state -------------------------------------------
  // We lazily open text blocks only once we know whether their first text is
  // inside a `<thinking>` tag or not. Thinking blocks are opened the moment
  // the parser emits reasoning. Both kinds close when the parser transitions
  // out, when the upstream text block ends, or at stream end.
  private nextIndex = 0;
  private openBlockType: BlockType = "none";
  private openBlockIndex = -1;

  // Upstream text-block indices we've suppressed (we'll re-emit our own).
  private suppressedTextBlocks = new Set<number>();

  // Remapping for non-text upstream blocks (tool_use, upstream-emitted
  // thinking, etc.) — upstreamIndex -> ourIndex.
  private indexMap = new Map<number, number>();

  // True once message_delta or message_stop has been forwarded. After this,
  // no content_block_* events may be emitted — the client has torn down its
  // message state and would reject them ("content_block_delta without a
  // current message").
  private messageEnded = false;

  _transform(
    chunk: Buffer,
    _encoding: string,
    callback: TransformCallback,
  ): void {
    for (const raw of this.reader.feed(chunk)) this.handleRawEvent(raw);
    callback();
  }

  _flush(callback: TransformCallback): void {
    // Trailing bytes (event without final blank line) — best effort.
    const frameTail = this.reader.flush();
    if (frameTail !== null) this.handleRawEvent(frameTail);

    // Only flush parser carry and close blocks if the message hasn't already
    // ended. Once message_delta/message_stop has been forwarded, emitting
    // further content_block_* events would arrive after the client tore down
    // its message state and cause "content_block_delta without a current
    // message" errors.
    if (!this.messageEnded) {
      // Flush any partial-tag carry the parser is holding, so the client still
      // sees trailing text that arrived without a closing `</thinking>`.
      const tail = this.parser.flush();
      if (tail.reasoning || tail.content) {
        for (const out of this.emitSplit(tail.reasoning, tail.content)) {
          this.push(out);
        }
      }

      // If a block is still open (upstream hung up mid-block), close it so the
      // client sees a well-formed block boundary.
      if (this.openBlockType !== "none") {
        this.push(
          formatEvent("content_block_stop", {
            type: "content_block_stop",
            index: this.openBlockIndex,
          }),
        );
        this.openBlockType = "none";
      }
    }

    callback();
  }

  // Parse + process one raw SSE event; on ANY error, pass the original bytes
  // through unchanged so the client stream never breaks.
  private handleRawEvent(raw: string): void {
    try {
      const parsed = parseEvent(raw);
      for (const out of this.processEvent(parsed)) {
        this.push(out);
      }
    } catch (err) {
      // Swallow the error and forward verbatim. We deliberately don't log
      // here to keep the transform dependency-free; the caller can observe
      // anomalies by inspecting the stream.
      this.push(raw + "\n\n");
    }
  }

  private processEvent(parsed: ParsedEvent): string[] {
    // data-less events (heartbeats, bare [DONE]) — forward as-is.
    if (!parsed.data) {
      return [parsed.raw + "\n\n"];
    }

    const eventType = parsed.event;
    const data = parsed.data;

    switch (eventType) {
      case "message_start":
      case "ping":
        // Lifecycle events: pass through unchanged.
        return [formatEvent(eventType, data)];

      case "message_stop":
        // The message is ending. Flush any parser carry and close blocks
        // BEFORE forwarding message_stop so no content_block_* events leak
        // past the end of the message.
        return [...this.finalizeBlocks(), formatEvent("message_stop", data)];

      case "message_delta": {
        // The message is about to end. Flush parser carry and close any block
        // we still have open so the client gets a clean block boundary (and
        // all deferred text) before stop_reason arrives.
        const outputs = this.finalizeBlocks();
        outputs.push(formatEvent("message_delta", data));
        return outputs;
      }

      case "content_block_start":
        return this.handleBlockStart(data);

      case "content_block_delta":
        return this.handleBlockDelta(data);

      case "content_block_stop":
        return this.handleBlockStop(data);

      default:
        // Unknown event type — forward verbatim rather than guess.
        return [formatEvent(eventType, data)];
    }
  }

  // --- Per-event handlers ---------------------------------------------------

  private handleBlockStart(data: Record<string, unknown>): string[] {
    const upstreamIndex = numOr(data.index, -1);
    const block = data.content_block as { type?: string } | undefined;
    const blockType = block?.type;

    if (blockType === "text") {
      // Lazy open: we don't yet know if the first delta will land in a
      // <thinking> tag. Suppress this start; we'll emit our own start when
      // the parser produces output.
      this.suppressedTextBlocks.add(upstreamIndex);
      return [];
    }

    // tool_use, upstream-emitted thinking, image, etc. — remap the index so
    // our inserted thinking/text blocks don't collide with the upstream's.
    const mappedIndex = this.nextIndex++;
    this.indexMap.set(upstreamIndex, mappedIndex);
    return [
      formatEvent("content_block_start", { ...data, index: mappedIndex }),
    ];
  }

  private handleBlockDelta(data: Record<string, unknown>): string[] {
    const upstreamIndex = numOr(data.index, -1);
    const delta = data.delta as { type?: string; text?: string } | undefined;
    const deltaType = delta?.type;

    if (deltaType === "text_delta" && delta && typeof delta.text === "string") {
      // Run the text through the thinking parser. The parser returns the
      // content/reasoning split for THIS chunk; we lazily open (or switch)
      // blocks based on which side has output.
      const result = this.parser.feed(delta.text);
      return this.emitSplit(result.reasoning, result.content);
    }

    // Non-text delta (input_json_delta for tool_use, upstream's own
    // thinking_delta, etc.) — remap the index and forward.
    if (this.indexMap.has(upstreamIndex)) {
      return [
        formatEvent("content_block_delta", {
          ...data,
          index: this.indexMap.get(upstreamIndex)!,
        }),
      ];
    }

    // Unknown delta (e.g., text_delta for a block we didn't see start of) —
    // forward verbatim rather than drop it.
    return [formatEvent("content_block_delta", data)];
  }

  private handleBlockStop(data: Record<string, unknown>): string[] {
    const upstreamIndex = numOr(data.index, -1);
    const outputs: string[] = [];

    if (this.indexMap.has(upstreamIndex)) {
      // Non-text block stop — remap and forward.
      outputs.push(
        formatEvent("content_block_stop", {
          type: "content_block_stop",
          index: this.indexMap.get(upstreamIndex)!,
        }),
      );
      this.indexMap.delete(upstreamIndex);
      return outputs;
    }

    if (this.suppressedTextBlocks.has(upstreamIndex)) {
      // End of a text block we suppressed. Flush any partial-tag carry the
      // parser still holds, then close whatever block we have open.
      this.suppressedTextBlocks.delete(upstreamIndex);
      const tail = this.parser.flush();
      if (tail.reasoning || tail.content) {
        outputs.push(...this.emitSplit(tail.reasoning, tail.content));
      }
      if (this.openBlockType !== "none") {
        outputs.push(
          formatEvent("content_block_stop", {
            type: "content_block_stop",
            index: this.openBlockIndex,
          }),
        );
        this.openBlockType = "none";
      }
      return outputs;
    }

    // Unknown block stop — forward verbatim.
    return [formatEvent("content_block_stop", data)];
  }

  // Emit thinking_delta / text_delta events for one parser result, opening
  // and closing content blocks as the parser transitions between reasoning
  // and content. Indices come from `nextIndex` and stay contiguous.
  //
  // `blockStarts` (how many <thinking> tags opened within THIS parser feed —
  // see StreamingThinkingParser) is otherwise unused here: earlier this
  // method opened one empty `{thinking:"", signature:""}` content block per
  // extra tag-open before the one carrying the actual text, so a chunk like
  // `<a/>text<b>` (two opens in one feed) produced a real block PLUS a bogus
  // empty one. Anthropic's own API never emits an empty thinking block, and
  // several clients treat one as malformed. Since the parser already
  // concatenates all reasoning text from one feed into a single `reasoning`
  // string regardless of how many tags it crossed, the correct — and
  // simpler — behavior is to fold every <thinking> tag in one feed into
  // whatever thinking block is already open (or open exactly one new block
  // if none is), never more than one block per feed call.
  private emitSplit(reasoning: string, content: string): string[] {
    const outputs: string[] = [];

    if (reasoning) {
      if (this.openBlockType !== "thinking") {
        outputs.push(...this.closeOpenBlock());
        const idx = this.nextIndex++;
        outputs.push(
          // Real Anthropic thinking blocks open with an empty `signature`
          // field too (not just `thinking`) — matches the live API's own
          // content_block_start shape for a not-yet-signed block.
          formatEvent("content_block_start", {
            type: "content_block_start",
            index: idx,
            content_block: { type: "thinking", thinking: "", signature: "" },
          }),
        );
        this.openBlockType = "thinking";
        this.openBlockIndex = idx;
      }
      outputs.push(
        formatEvent("content_block_delta", {
          type: "content_block_delta",
          index: this.openBlockIndex,
          delta: { type: "thinking_delta", thinking: reasoning },
        }),
      );
    }

    if (content) {
      if (this.openBlockType !== "text") {
        outputs.push(...this.closeOpenBlock());
        const idx = this.nextIndex++;
        outputs.push(
          formatEvent("content_block_start", {
            type: "content_block_start",
            index: idx,
            content_block: { type: "text", text: "" },
          }),
        );
        this.openBlockType = "text";
        this.openBlockIndex = idx;
      }
      outputs.push(
        formatEvent("content_block_delta", {
          type: "content_block_delta",
          index: this.openBlockIndex,
          delta: { type: "text_delta", text: content },
        }),
      );
    }

    return outputs;
  }

  // Real Anthropic extended-thinking streams end a thinking block with a
  // `signature_delta` event (the cryptographic signature) BEFORE
  // content_block_stop. This block's text was extracted from an inline
  // <thinking> tag rather than produced by a genuine Anthropic thinking
  // turn, so there's no real signature to relay — SYNTHETIC_THINKING_SIGNATURE
  // fills the slot so the block's SHAPE matches a real one. See that
  // constant's doc comment: stripUnsupportedThinking normalizes every
  // thinking block back to text before any request reaches a
  // messages-speaking upstream, so this placeholder is never round-tripped
  // anywhere that would need it to be a real signature.
  private closeOpenBlock(): string[] {
    if (this.openBlockType === "none") return [];
    const out: string[] = [];
    if (this.openBlockType === "thinking") {
      out.push(
        formatEvent("content_block_delta", {
          type: "content_block_delta",
          index: this.openBlockIndex,
          delta: {
            type: "signature_delta",
            signature: SYNTHETIC_THINKING_SIGNATURE,
          },
        }),
      );
    }
    out.push(
      formatEvent("content_block_stop", {
        type: "content_block_stop",
        index: this.openBlockIndex,
      }),
    );
    this.openBlockType = "none";
    return out;
  }

  // Flush parser carry (partial tags held from the last text_delta) and close
  // any open content block. Called from message_delta/message_stop handlers so
  // all deferred text reaches the client BEFORE the message ends — and so
  // _flush() knows there is nothing left to emit.
  private finalizeBlocks(): string[] {
    const outputs: string[] = [];
    const tail = this.parser.flush();
    if (tail.reasoning || tail.content) {
      outputs.push(...this.emitSplit(tail.reasoning, tail.content));
    }
    outputs.push(...this.closeOpenBlock());
    this.messageEnded = true;
    return outputs;
  }
}

// --- SSE parsing / formatting helpers ---------------------------------------

function numOr(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

// Parse one raw SSE event (the bytes between two blank-line separators) into
// its `event:` name and a JSON-decoded `data:` payload. Returns data=null for
// non-JSON payloads (e.g. bare `[DONE]`); the caller passes those through.
function parseEvent(raw: string): ParsedEvent {
  const lines = raw.split("\n");
  let event = "";
  let dataStr = "";
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      const payload = line.slice(5);
      dataStr += payload.startsWith(" ") ? payload.slice(1) : payload;
      dataStr += "\n";
    }
  }
  const trimmed = dataStr.trimEnd();
  let data: Record<string, unknown> | null = null;
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      } else {
        // Valid JSON but not an object — wrap so the caller can still forward.
        data = { __raw: parsed };
      }
    } catch {
      // Non-JSON data line (rare; e.g. a bare string). Leave data=null so the
      // caller forwards the original bytes verbatim.
      data = null;
    }
  }
  return { event, data, raw };
}

function formatEvent(eventType: string, data: Record<string, unknown>): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}
