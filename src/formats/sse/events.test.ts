// Typed SSE per-event transform tests.
//
// SseEventTransform (what onStreamEvent wraps) owns the SSE framing: it buffers
// bytes across chunk boundaries, parses each event's data JSON, calls a typed
// handler, and re-serializes. Returning null drops an event; [DONE] and non-JSON
// events pass through; the Anthropic `event:` line is re-emitted for messages.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SseEventTransform } from "./events";
import type { TransformCtx } from "../pipeline";
import type { Provider } from "../../types";

const ctx: TransformCtx = {
  provider: { id: "p" } as unknown as Provider,
  clientFmt: "chat",
  providerFmt: "chat",
};

// Drive bytes through a transform and collect the emitted string.
function run(t: SseEventTransform, chunks: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    t.on("data", (c) => (out += c.toString("utf8")));
    t.on("end", () => resolve(out));
    t.on("error", reject);
    for (const c of chunks) t.write(Buffer.from(c, "utf8"));
    t.end();
  });
}

test("edits a typed event and re-serializes (chat: no event line)", async () => {
  const t = new SseEventTransform(
    "chat",
    (data) => ({ ...data, edited: true }),
    ctx,
  );
  const out = await run(t, ['data: {"a":1}\n\n']);
  assert.equal(out, 'data: {"a":1,"edited":true}\n\n');
});

test("returning null drops the event", async () => {
  const t = new SseEventTransform(
    "chat",
    (data) => ((data as { skip?: boolean }).skip ? null : data),
    ctx,
  );
  const out = await run(t, ['data: {"skip":true}\n\n', 'data: {"keep":1}\n\n']);
  assert.equal(out, 'data: {"keep":1}\n\n');
});

test("[DONE] sentinel passes through untouched", async () => {
  const t = new SseEventTransform("chat", (d) => d, ctx);
  const out = await run(t, ['data: {"a":1}\n\n', "data: [DONE]\n\n"]);
  assert.equal(out, 'data: {"a":1}\n\ndata: [DONE]\n\n');
});

test("buffers across a chunk boundary (event split mid-JSON)", async () => {
  const t = new SseEventTransform("chat", (d) => d, ctx);
  const out = await run(t, ['data: {"a":', "1}\n\n"]);
  assert.equal(out, 'data: {"a":1}\n\n');
});

test("messages format re-emits the event: line from the event type", async () => {
  const t = new SseEventTransform("messages", (d) => d, ctx);
  const out = await run(t, [
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]);
  assert.equal(out, 'event: message_stop\ndata: {"type":"message_stop"}\n\n');
});

test("non-JSON data passes through unchanged", async () => {
  const t = new SseEventTransform("chat", () => ({ replaced: true }), ctx);
  const out = await run(t, ["data: not json\n\n"]);
  assert.equal(out, "data: not json\n\n");
});

test("a throwing handler falls back to the original event (never crashes)", async () => {
  const t = new SseEventTransform(
    "chat",
    () => {
      throw new Error("boom");
    },
    ctx,
  );
  const out = await run(t, ['data: {"a":1}\n\n']);
  assert.equal(out, 'data: {"a":1}\n\n');
});
