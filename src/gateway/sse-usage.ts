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
import { readCachedTokens } from "../formats/tokens";
import type { ResponseSummary } from "./debug-capture";

export interface StreamUsage {
  input?: number;
  output?: number;
  cached?: number;
}

// Per-string cap while accumulating streamed text/args, so a runaway stream
// can't grow the in-memory buffers without bound.
const CAPTURE_TEXT_CAP = 4_000;
const CAPTURE_ARG_CAP = 4_000;

export class SseUsageObserver extends Transform {
  private tail = "";
  private seenInput: number | null = null;
  private seenOutput: number | null = null;
  private seenCached: number | null = null;
  private fallbackChars = 0;

  // --- optional debug capture (off unless enabled) ---
  private readonly capture: boolean;
  private text = "";
  private stopReason: unknown = undefined;
  // Tool calls keyed by streaming index; arguments accumulate across deltas.
  private tools = new Map<number, { name?: unknown; arguments: string }>();

  constructor(opts?: { capture?: boolean }) {
    super();
    this.capture = opts?.capture ?? false;
  }

  // Distilled response summary observed so far (text + tool calls + stop
  // reason). Returns null when capture is off or nothing was seen.
  responseSummary(): ResponseSummary | null {
    if (!this.capture) return null;
    const toolCalls = [...this.tools.values()].map((t) => ({
      name: t.name,
      arguments: t.arguments,
    }));
    const s: ResponseSummary = {};
    if (this.text) s.text = this.text;
    if (toolCalls.length) s.toolCalls = toolCalls;
    if (this.stopReason !== undefined) s.stopReason = this.stopReason;
    return s.text || s.toolCalls || s.stopReason !== undefined ? s : null;
  }

  // Best-effort usage totals observed so far. Prefers upstream-reported counts;
  // falls back to a chars/4 estimate of the streamed text when output wasn't
  // reported (input falls back to the caller's pre-request estimate).
  usage(inputEstimate: number): StreamUsage {
    const input = this.seenInput ?? (inputEstimate || undefined);
    const output =
      this.seenOutput ??
      (this.fallbackChars > 0 ? Math.ceil(this.fallbackChars / 4) : undefined);
    return {
      input,
      output,
      ...(this.seenCached != null ? { cached: this.seenCached } : {}),
    };
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
    this.readUsage(
      (obj.response as Record<string, unknown> | undefined)?.usage,
    );
    // Fallback: accumulate streamed assistant text so we can estimate output
    // tokens when the upstream never sends a usage block.
    this.readDelta(obj);
    if (this.capture) this.captureEvent(obj);
  }

  // Accumulate assistant text + tool-call fragments from one SSE event across
  // the wire formats. Best-effort: any unrecognised shape is ignored.
  private captureEvent(obj: Record<string, unknown>): void {
    const addText = (s: unknown) => {
      if (typeof s === "string" && s && this.text.length < CAPTURE_TEXT_CAP)
        this.text += s;
    };
    const addArg = (idx: number, name: unknown, frag: unknown) => {
      let t = this.tools.get(idx);
      if (!t) {
        t = { name, arguments: "" };
        this.tools.set(idx, t);
      }
      if (name !== undefined && t.name === undefined) t.name = name;
      if (typeof frag === "string" && t.arguments.length < CAPTURE_ARG_CAP)
        t.arguments += frag;
    };

    // Anthropic Messages SSE.
    const type = obj.type;
    if (type === "content_block_start") {
      const block = (obj.content_block ?? {}) as Record<string, unknown>;
      if (block.type === "tool_use")
        addArg(Number(obj.index ?? this.tools.size), block.name, "");
    } else if (type === "content_block_delta") {
      const d = (obj.delta ?? {}) as Record<string, unknown>;
      if (typeof d.text === "string") addText(d.text);
      if (typeof d.thinking === "string") addText(d.thinking);
      if (typeof d.partial_json === "string")
        addArg(Number(obj.index ?? 0), undefined, d.partial_json);
    } else if (type === "message_delta") {
      const d = (obj.delta ?? {}) as Record<string, unknown>;
      if (d.stop_reason !== undefined) this.stopReason = d.stop_reason;
    }

    // OpenAI Chat SSE: choices[].delta.{content, tool_calls[]}.
    if (Array.isArray(obj.choices)) {
      for (const ch of obj.choices as Array<Record<string, unknown>>) {
        const d = (ch.delta ?? {}) as Record<string, unknown>;
        addText(d.content);
        if (Array.isArray(d.tool_calls))
          for (const tc of d.tool_calls as Array<Record<string, unknown>>) {
            const fn = (tc.function ?? {}) as Record<string, unknown>;
            addArg(Number(tc.index ?? 0), fn.name, fn.arguments);
          }
        if (ch.finish_reason != null) this.stopReason = ch.finish_reason;
      }
    }

    // OpenAI Responses SSE: output_text deltas + function_call args.
    if (type === "response.output_text.delta") addText(obj.delta);
    if (type === "response.function_call_arguments.delta")
      addArg(Number(obj.output_index ?? 0), undefined, obj.delta);
  }

  private readUsage(u: unknown): void {
    if (!u || typeof u !== "object") return;
    const o = u as Record<string, unknown>;
    const input = num(o.input_tokens) ?? num(o.prompt_tokens) ?? null;
    const output = num(o.output_tokens) ?? num(o.completion_tokens) ?? null;
    if (input != null) this.seenInput = Math.max(this.seenInput ?? 0, input);
    if (output != null)
      this.seenOutput = Math.max(this.seenOutput ?? 0, output);
    const cached = readCachedTokens(o);
    if (cached != null)
      this.seenCached = Math.max(this.seenCached ?? 0, cached);
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
          Record<string, unknown> | undefined;
        if (cd && typeof cd.content === "string")
          this.fallbackChars += cd.content.length;
      }
    }
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
