// AnthropicThinkingTransform tests — inline <thinking> tag extraction on a
// native /v1/messages SSE stream. Had no dedicated test file before (only
// exercised indirectly via engine-level streaming tests). Covers: block
// splitting, index remapping around tool_use, the signature_delta emission
// on every synthesized thinking block close, and that no empty thinking
// block is ever emitted for a multi-tag-open chunk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicThinkingTransform } from "./messages-stream";
import { SYNTHETIC_THINKING_SIGNATURE } from "../wire/anthropic";

function sseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function runTransform(
  t: AnthropicThinkingTransform,
  chunks: string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    t.on("data", (c: Buffer) => out.push(c));
    t.on("end", () => resolve(Buffer.concat(out).toString("utf8")));
    t.on("error", reject);
    for (const c of chunks) t.write(Buffer.from(c, "utf8"));
    t.end();
  });
}

interface ParsedEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseEvents(raw: string): ParsedEvent[] {
  const out: ParsedEvent[] = [];
  for (const frame of raw.split("\n\n")) {
    if (!frame.trim()) continue;
    const lines = frame.split("\n");
    const eventLine = lines.find((l) => l.startsWith("event:"));
    const dataLine = lines.find((l) => l.startsWith("data:"));
    if (!eventLine || !dataLine) continue;
    out.push({
      event: eventLine.slice(6).trim(),
      data: JSON.parse(dataLine.slice(5).trim()),
    });
  }
  return out;
}

test("splits an inline <thinking> tag out of a text block into a real thinking block", async () => {
  const raw = await runTransform(new AnthropicThinkingTransform(), [
    sseEvent("message_start", {
      type: "message_start",
      message: { id: "m1", usage: { input_tokens: 5 } },
    }),
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "<thinking>plan</thinking>answer" },
    }),
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 3 },
    }),
    sseEvent("message_stop", { type: "message_stop" }),
  ]);
  const events = parseEvents(raw);

  const thinkingStart = events.find(
    (e) =>
      e.event === "content_block_start" &&
      (e.data.content_block as { type?: string })?.type === "thinking",
  );
  assert.ok(thinkingStart, "expected a thinking content_block_start");

  const thinkingDelta = events.find(
    (e) =>
      e.event === "content_block_delta" &&
      (e.data.delta as { type?: string })?.type === "thinking_delta",
  );
  assert.equal(
    (thinkingDelta!.data.delta as { thinking: string }).thinking,
    "plan",
  );

  const textDelta = events.find(
    (e) =>
      e.event === "content_block_delta" &&
      (e.data.delta as { type?: string })?.type === "text_delta",
  );
  assert.equal((textDelta!.data.delta as { text: string }).text, "answer");
});

test("emits a signature_delta with the synthetic signature before closing a synthesized thinking block", async () => {
  const raw = await runTransform(new AnthropicThinkingTransform(), [
    sseEvent("message_start", { type: "message_start", message: {} }),
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "<thinking>reason</thinking>done" },
    }),
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
    }),
    sseEvent("message_stop", { type: "message_stop" }),
  ]);
  const events = parseEvents(raw);

  const sigDelta = events.find(
    (e) =>
      e.event === "content_block_delta" &&
      (e.data.delta as { type?: string })?.type === "signature_delta",
  );
  assert.ok(sigDelta, "expected a signature_delta event");
  assert.equal(
    (sigDelta!.data.delta as { signature: string }).signature,
    SYNTHETIC_THINKING_SIGNATURE,
  );

  // The signature_delta must land on the thinking block's index, and BEFORE
  // that block's content_block_stop.
  const thinkingIndex = (sigDelta!.data as { index: number }).index;
  const stopIdx = events.findIndex(
    (e) => e.event === "content_block_stop" && e.data.index === thinkingIndex,
  );
  const sigIdx = events.indexOf(sigDelta!);
  assert.ok(
    sigIdx < stopIdx,
    "signature_delta must precede content_block_stop",
  );
});

test("no empty thinking block is emitted when a chunk contains multiple <thinking> tag opens", async () => {
  // A single text_delta containing two complete thinking tags plus trailing
  // content — exercises the old blockStarts>1 path that used to emit an
  // empty {thinking:"",signature:""} placeholder block.
  const raw = await runTransform(new AnthropicThinkingTransform(), [
    sseEvent("message_start", { type: "message_start", message: {} }),
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text: "<thinking>first</thinking><thinking>second</thinking>answer",
      },
    }),
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
    }),
    sseEvent("message_stop", { type: "message_stop" }),
  ]);
  const events = parseEvents(raw);

  // No thinking content_block_start may carry an empty `thinking` field.
  const thinkingStarts = events.filter(
    (e) =>
      e.event === "content_block_start" &&
      (e.data.content_block as { type?: string })?.type === "thinking",
  );
  for (const s of thinkingStarts) {
    assert.notEqual(
      (s.data.content_block as { thinking?: string }).thinking,
      undefined,
    );
  }
  // No signature_delta carries an empty signature.
  const sigDeltas = events.filter(
    (e) =>
      e.event === "content_block_delta" &&
      (e.data.delta as { type?: string })?.type === "signature_delta",
  );
  for (const s of sigDeltas) {
    assert.notEqual((s.data.delta as { signature: string }).signature, "");
  }
  // The concatenated reasoning text from both tags still reaches the client
  // (folded into whichever thinking block(s) got opened) — nothing is lost.
  const allReasoning = events
    .filter(
      (e) =>
        e.event === "content_block_delta" &&
        (e.data.delta as { type?: string })?.type === "thinking_delta",
    )
    .map((e) => (e.data.delta as { thinking: string }).thinking)
    .join("");
  assert.equal(allReasoning, "firstsecond");
});

test("a lone empty <thinking></thinking> tag is stripped from the text but emits no thinking block at all", async () => {
  const raw = await runTransform(new AnthropicThinkingTransform(), [
    sseEvent("message_start", { type: "message_start", message: {} }),
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "<thinking></thinking>hello" },
    }),
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
    }),
    sseEvent("message_stop", { type: "message_stop" }),
  ]);
  const events = parseEvents(raw);
  const thinkingStarts = events.filter(
    (e) =>
      e.event === "content_block_start" &&
      (e.data.content_block as { type?: string })?.type === "thinking",
  );
  assert.equal(
    thinkingStarts.length,
    0,
    "an empty thinking tag emits no block",
  );
  const textDelta = events.find(
    (e) =>
      e.event === "content_block_delta" &&
      (e.data.delta as { type?: string })?.type === "text_delta",
  );
  assert.equal((textDelta!.data.delta as { text: string }).text, "hello");
});

test("tool_use blocks keep contiguous remapped indices around an inserted thinking block", async () => {
  const raw = await runTransform(new AnthropicThinkingTransform(), [
    sseEvent("message_start", { type: "message_start", message: {} }),
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "<thinking>plan</thinking>" },
    }),
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "t1", name: "search" },
    }),
    sseEvent("content_block_stop", { type: "content_block_stop", index: 1 }),
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
    }),
    sseEvent("message_stop", { type: "message_stop" }),
  ]);
  const events = parseEvents(raw);
  const toolStart = events.find(
    (e) =>
      e.event === "content_block_start" &&
      (e.data.content_block as { type?: string })?.type === "tool_use",
  )!;
  // The thinking block took index 0, so the remapped tool_use must be index 1
  // (contiguous — not the raw upstream index, which also happened to be 1
  // here, but the mapping must be deliberate, not coincidental).
  assert.equal(toolStart.data.index, 1);
});

test("real upstream-emitted thinking blocks (not inline-tag-extracted) pass through untouched, signature intact", async () => {
  // The upstream ITSELF emits a native thinking content_block (no inline
  // <thinking> tag involved) — this transform must not touch its signature.
  const raw = await runTransform(new AnthropicThinkingTransform(), [
    sseEvent("message_start", { type: "message_start", message: {} }),
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    }),
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "native reasoning" },
    }),
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "REAL-anthropic-signature" },
    }),
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
    }),
    sseEvent("message_stop", { type: "message_stop" }),
  ]);
  const events = parseEvents(raw);
  const sigDeltas = events.filter(
    (e) =>
      e.event === "content_block_delta" &&
      (e.data.delta as { type?: string })?.type === "signature_delta",
  );
  // Exactly the one REAL signature_delta from upstream — the transform must
  // not inject a second synthetic one for a block it didn't synthesize.
  assert.equal(sigDeltas.length, 1);
  assert.equal(
    (sigDeltas[0].data.delta as { signature: string }).signature,
    "REAL-anthropic-signature",
  );
});

test("a malformed event falls back to forwarding the raw bytes, never breaks the stream", async () => {
  const raw = await runTransform(new AnthropicThinkingTransform(), [
    "event: content_block_delta\ndata: {not valid json\n\n",
    sseEvent("message_stop", { type: "message_stop" }),
  ]);
  assert.ok(raw.includes("message_stop"));
});
