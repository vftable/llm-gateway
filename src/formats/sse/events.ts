// Typed SSE per-event transform.
//
// A reusable Node Transform that owns the tedious SSE plumbing — buffering bytes
// across chunk boundaries, splitting on the `\n\n` event delimiter, parsing the
// `data:` payload as JSON, and re-serializing — so a transform author only writes
// a typed `(event, ctx) => event | null` handler. Returning null drops the event;
// the `[DONE]` sentinel and non-JSON events pass through untouched.
//
// This is what `onStreamEvent(format, …)` (see pipeline.ts) wraps: it binds the
// handler to `WireStreamEvent<F>` for the tagged format so the author edits typed
// events (ChatCompletionChunk / AnthropicStreamEvent / ResponsesStreamEvent).

import { Transform, type TransformCallback } from "stream";
import type { TransformCtx } from "../pipeline";
import { SseFrameReader, parseSseData } from "./frame";

// One parsed SSE event handed to the handler. `event` is the value of the SSE
// `event:` line (Anthropic uses it; OpenAI does not) — preserved on re-emit.
export type SseEventHandler = (
  data: Record<string, unknown>,
  ctx: TransformCtx,
) => Record<string, unknown> | null;

// Whether re-emitted events carry an `event: <type>` line. Anthropic Messages
// SSE requires it (clients key off it); OpenAI chat/responses SSE does not.
function needsEventLine(fmt: "chat" | "messages" | "responses"): boolean {
  return fmt === "messages";
}

export class SseEventTransform extends Transform {
  private readonly reader = new SseFrameReader();
  private readonly fmt: "chat" | "messages" | "responses";
  private readonly handler: SseEventHandler;
  private readonly ctx: TransformCtx;

  constructor(
    fmt: "chat" | "messages" | "responses",
    handler: SseEventHandler,
    ctx: TransformCtx,
  ) {
    super();
    this.fmt = fmt;
    this.handler = handler;
    this.ctx = ctx;
  }

  _transform(chunk: Buffer, _enc: string, cb: TransformCallback): void {
    for (const evt of this.reader.feed(chunk)) this.emitEvent(evt);
    cb();
  }

  _flush(cb: TransformCallback): void {
    const tail = this.reader.flush();
    if (tail) this.emitEvent(tail);
    cb();
  }

  // Parse one raw event block, run the handler, re-serialize. Passes comment /
  // keepalive blocks, [DONE], and non-JSON payloads through verbatim.
  private emitEvent(raw: string): void {
    const { data: dataStr } = parseSseData(raw);
    // No data payload (comment/keepalive) — pass the block through unchanged.
    if (dataStr === null) {
      this.push(raw + "\n\n");
      return;
    }
    if (dataStr === "[DONE]") {
      this.push("data: [DONE]\n\n");
      return;
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      // Not JSON — pass through untouched.
      this.push(raw + "\n\n");
      return;
    }

    let out: Record<string, unknown> | null;
    try {
      out = this.handler(data, this.ctx);
    } catch {
      out = data; // never let a handler crash the stream
    }
    if (out == null) return; // dropped

    if (needsEventLine(this.fmt)) {
      const type = typeof out.type === "string" ? out.type : "";
      this.push(`event: ${type}\ndata: ${JSON.stringify(out)}\n\n`);
    } else {
      this.push(`data: ${JSON.stringify(out)}\n\n`);
    }
  }
}
