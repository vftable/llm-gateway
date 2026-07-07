// Pass-through SSE observer that sniffs token usage out of a streaming
// response without altering a single byte of it.
//
// Streaming requests never carry a final JSON body to reconcile against, so
// the gateway would otherwise never learn the real token counts for a stream.
// This Transform sits first in the streaming pipeline (on the PROVIDER-native
// SSE bytes, before any format bridge), scans each `data:` event for usage
// numbers, and — when the upstream reports none — accumulates the length of the
// streamed text deltas as a fallback output estimate. It forwards every chunk
// unchanged; a parse error on one event is swallowed so it can never break the
// stream.
//
// Usage locations understood (union across the formats the gateway serves):
//   - top-level        .usage                       (OpenAI chat final chunk)
//   - Anthropic        .message.usage / message_delta.usage
//   - OpenAI Responses .response.usage
// Token field names: {input_tokens|prompt_tokens} and
// {output_tokens|completion_tokens}. Output is cumulative/one-shot, so the max
// seen is the final total.

import { Transform, type TransformCallback } from "stream";

export interface StreamUsage {
  input?: number;
  output?: number;
}

export class SseUsageObserver extends Transform {
  private tail = "";
  private seenInput: number | null = null;
  private seenOutput: number | null = null;
  private fallbackChars = 0;

  // Best-effort usage totals observed so far. Prefers upstream-reported counts;
  // falls back to a chars/4 estimate of the streamed text when output wasn't
  // reported (input falls back to the caller's pre-request estimate).
  usage(inputEstimate: number): StreamUsage {
    const input = this.seenInput ?? (inputEstimate || undefined);
    const output =
      this.seenOutput ??
      (this.fallbackChars > 0 ? Math.ceil(this.fallbackChars / 4) : undefined);
    return { input, output };
  }

  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    try {
      this.scan(chunk);
    } catch {
      /* observation must never disrupt the stream */
    }
    cb(null, chunk); // forward verbatim
  }

  private scan(chunk: Buffer): void {
    const text = this.tail + chunk.toString("utf8");
    const lines = text.split("\n");
    // Keep the last (possibly partial) line buffered for the next chunk.
    this.tail = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let obj: unknown;
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }
      this.absorb(obj as Record<string, unknown>);
    }
  }

  private absorb(obj: Record<string, unknown>): void {
    if (!obj || typeof obj !== "object") return;
    // Usage can live at a few nesting levels depending on the wire format.
    this.readUsage(obj.usage);
    this.readUsage((obj.message as Record<string, unknown> | undefined)?.usage);
    this.readUsage((obj.response as Record<string, unknown> | undefined)?.usage);
    // Fallback: accumulate streamed assistant text so we can estimate output
    // tokens when the upstream never sends a usage block.
    this.readDelta(obj);
  }

  private readUsage(u: unknown): void {
    if (!u || typeof u !== "object") return;
    const o = u as Record<string, unknown>;
    const input =
      num(o.input_tokens) ?? num(o.prompt_tokens) ?? null;
    const output =
      num(o.output_tokens) ?? num(o.completion_tokens) ?? null;
    if (input != null)
      this.seenInput = Math.max(this.seenInput ?? 0, input);
    if (output != null)
      this.seenOutput = Math.max(this.seenOutput ?? 0, output);
  }

  private readDelta(obj: Record<string, unknown>): void {
    const delta = obj.delta;
    if (typeof delta === "string") {
      this.fallbackChars += delta.length; // Responses output_text delta
    } else if (delta && typeof delta === "object") {
      const d = delta as Record<string, unknown>;
      for (const v of [d.text, d.thinking, d.partial_json, d.content])
        if (typeof v === "string") this.fallbackChars += v.length;
    }
    const choices = obj.choices;
    if (Array.isArray(choices)) {
      for (const c of choices) {
        const cd = (c as Record<string, unknown>)?.delta as
          | Record<string, unknown>
          | undefined;
        if (cd && typeof cd.content === "string")
          this.fallbackChars += cd.content.length;
      }
    }
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
