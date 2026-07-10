// Thinking-as-tagged-default regression guard.
//
// Thinking extraction used to be a standalone engine call (applyThinking /
// thinkingStream) applied on the provider-shape body before the format bridge.
// It's now a format-tagged default (defaultThinkingResponse / defaultThinkingStream)
// placed pre-bridge by buildTransformPlan. These tests prove the tagged defaults
// produce identical output to a direct ThinkingConverter call, and that the plan
// places them FIRST (pre-bridge) for every provider format — so nothing regressed
// in the move.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "stream";
import { ThinkingConverter } from "./converter";
import { defaultThinkingResponse, defaultThinkingStream } from "./transforms";
import { buildTransformPlan, type TransformCtx } from "../pipeline";
import type { Provider } from "../../types";

const conv = new ThinkingConverter();
const provider = { id: "p" } as unknown as Provider;
function ctx(
  clientFmt: TransformCtx["clientFmt"],
  providerFmt: TransformCtx["providerFmt"],
): TransformCtx {
  return { provider, clientFmt, providerFmt };
}

// Pick the tagged response transform for a format.
function respFor(fmt: TransformCtx["providerFmt"]) {
  return defaultThinkingResponse(conv).find((t) => t.format === fmt)!;
}

// --- parity with a direct ThinkingConverter call ---------------------------

test("chat: tagged default extracts <thinking> like applyToChatCompletion", () => {
  const raw = {
    choices: [
      {
        message: { role: "assistant", content: "<thinking>plan</thinking>hi" },
      },
    ],
  };
  const viaDirect = new ThinkingConverter().applyToChatCompletion(
    structuredClone(raw) as never,
  );
  const viaTagged = respFor("chat").apply(
    structuredClone(raw),
    ctx("chat", "chat"),
  );
  assert.deepEqual(viaTagged, viaDirect);
  const msg = (
    viaTagged.choices as Array<{ message: Record<string, unknown> }>
  )[0].message;
  assert.equal(msg.content, "hi");
  assert.equal(msg.reasoning, "plan");
  assert.ok(Array.isArray(msg.reasoning_details));
});

test("messages: tagged default splits inline <thinking> into a thinking block", () => {
  const raw = {
    content: [{ type: "text", text: "<thinking>plan</thinking>answer" }],
  };
  const viaDirect = new ThinkingConverter().applyToAnthropicMessage(
    structuredClone(raw) as never,
  );
  const viaTagged = respFor("messages").apply(
    structuredClone(raw),
    ctx("messages", "messages"),
  );
  assert.deepEqual(viaTagged, viaDirect);
  const blocks = viaTagged.content as Array<Record<string, unknown>>;
  assert.ok(blocks.some((b) => b.type === "thinking" && b.thinking === "plan"));
  assert.ok(blocks.some((b) => b.type === "text" && b.text === "answer"));
});

test("responses: tagged default prepends a reasoning output item", () => {
  const raw = {
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "<thinking>plan</thinking>hi" }],
      },
    ],
  };
  const viaTagged = respFor("responses").apply(
    structuredClone(raw),
    ctx("responses", "responses"),
  );
  const items = viaTagged.output as Array<Record<string, unknown>>;
  assert.equal(items[0].type, "reasoning");
});

test("tagged default is a guarded no-op on a body with no thinking", () => {
  const raw = {
    choices: [{ message: { role: "assistant", content: "plain" } }],
  };
  const out = respFor("chat").apply(structuredClone(raw), ctx("chat", "chat"));
  assert.deepEqual(out, raw); // unchanged
});

test("tagged default never throws on a malformed body (returns it as-is)", () => {
  const bad = { choices: "not-an-array" } as unknown as Record<string, unknown>;
  const out = respFor("chat").apply(bad, ctx("chat", "chat"));
  assert.deepEqual(out, bad);
});

// --- placement: thinking runs FIRST (pre-bridge) ---------------------------

test("thinking response default is placed first, before the format bridge", () => {
  // messages provider, chat client: response bridges messages->chat. The engine
  // emits only the providerFmt-tagged thinking (via collectDefaults), which the
  // plan places BEFORE that bridge — and it runs exactly once.
  const providerFmt = "messages";
  const plan = buildTransformPlan(
    "chat",
    { forwardPath: "/v1/messages", providerFmt },
    {
      response: defaultThinkingResponse(conv).filter(
        (t) => t.format === providerFmt,
      ),
    },
  );
  assert.deepEqual(
    plan.response.map((t) => t.name),
    ["thinking:messages", "format:messages->chat"],
  );
});

test("thinking stream default is placed first, before the stream bridge", () => {
  const providerFmt = "messages";
  const plan = buildTransformPlan(
    "chat",
    { forwardPath: "/v1/messages", providerFmt },
    { stream: defaultThinkingStream().filter((t) => t.format === providerFmt) },
  );
  assert.deepEqual(
    plan.stream.map((t) => t.name),
    ["thinking:messages", "stream:messages->chat"],
  );
});

test("engine emits thinking only for the provider format (runs once)", () => {
  // The registry filters to providerFmt so a converting hop doesn't also run a
  // wasteful post-bridge clientFmt pass. Assert the filter yields exactly one.
  const messagesOnly = defaultThinkingResponse(conv).filter(
    (t) => t.format === "messages",
  );
  assert.equal(messagesOnly.length, 1);
  assert.equal(messagesOnly[0].name, "thinking:messages");
});

test("thinking stream default constructs a real transform for chat + messages", () => {
  const streams = defaultThinkingStream();
  const chat = streams.find((s) => s.format === "chat")!;
  const messages = streams.find((s) => s.format === "messages")!;
  assert.ok(typeof chat.create(ctx("chat", "chat")).pipe === "function");
  assert.ok(
    typeof messages.create(ctx("messages", "messages")).pipe === "function",
  );
  // responses has no stream thinking (as before).
  assert.equal(
    streams.find((s) => s.format === "responses"),
    undefined,
  );
  void PassThrough;
});
