// Mistral thinking lift: the model ships reasoning INSIDE content as
// {type:"thinking", thinking:[{type:"text",text}]} chunks (verified live on
// deepseek-v4-1-flash-1017). These tests pin the lift into the OpenAI-style
// reasoning_content / reasoning_details fields the wire bridges consume, on
// both the buffered and the streaming path.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Transform as StreamTransform } from "stream";
import { mistral } from "./mistral";
import type { TransformCtx } from "../../formats/pipeline";
import type { Provider } from "../../types";
import type { ChatCompletionChunk } from "../../formats/wire/openai-chat";

const provider = { id: "mistral-test", catalogId: "mistral" } as Provider;
const ctx = { provider } as TransformCtx;

// Buffered: apply the adapter's (only) response transform's typed handler.
function liftBuffered<T>(body: unknown): T {
  const t = mistral.responseTransforms(provider)[0];
  return (t.apply(body as never, ctx) as unknown) as T;
}

// Stream: onStreamEvent wraps a SseEventTransform; feed it an SSE byte stream
// and collect the JSON data payloads coming back ([DONE] passes verbatim).
function liftStream(
  chunk: Record<string, unknown>,
): Promise<Array<ChatCompletionChunk | "data: [DONE]">> {
  const out: Array<ChatCompletionChunk | "data: [DONE]"> = [];
  const t = mistral.streamTransforms(provider)[0].create(ctx) as StreamTransform;
  t.on("data", (d: Buffer) => {
    const s = String(d);
    if (s.startsWith("data: [DONE]")) out.push("data: [DONE]");
    else out.push(JSON.parse(s.slice("data: ".length)) as ChatCompletionChunk);
  });
  t.write(`data: ${JSON.stringify(chunk)}\n\n`);
  t.write("data: [DONE]\n\n");
  t.end();
  return new Promise<Array<ChatCompletionChunk | "data: [DONE]">>(
    (resolve, reject) => {
      t.on("end", () => resolve(out));
      t.on("error", reject);
    },
  );
}

const think = (text: string) => ({
  type: "thinking",
  thinking: [{ type: "text", text }],
  closed: true,
});
const text = (t: string) => ({ type: "text", text: t });

test("buffered: thinking part lifts into reasoning_content + reasoning_details", () => {
  const out = liftBuffered({
    choices: [
      {
        message: {
          role: "assistant",
          content: [think("We need answer classic."), text("Ball = 0.05.")],
        },
      },
    ],
  }) as { choices: Array<{ message: Record<string, unknown> }> };
  const msg = out.choices[0].message;
  assert.equal(msg.reasoning_content, "We need answer classic.");
  assert.deepEqual(msg.reasoning_details, [
    { type: "reasoning.text", text: "We need answer classic." },
  ]);
  // Content keeps only the non-thinking parts.
  assert.deepEqual(msg.content, [text("Ball = 0.05.")]);
});

test("buffered: all-thinking content collapses to an empty string", () => {
  const out = liftBuffered({
    choices: [
      {
        message: {
          role: "assistant",
          content: [think("a"), think("b")],
        },
      },
    ],
  }) as { choices: Array<{ message: Record<string, unknown> }> };
  const msg = out.choices[0].message;
  assert.equal(msg.reasoning_content, "ab");
  assert.equal(msg.content, "");
});

test("buffered: an existing reasoning_content is appended, not clobbered", () => {
  const out = liftBuffered({
    choices: [
      {
        message: {
          role: "assistant",
          reasoning_content: "previously ",
          content: [think("lifted")],
        },
      },
    ],
  }) as { choices: Array<{ message: Record<string, unknown> }> };
  assert.equal(
    out.choices[0].message.reasoning_content,
    "previously lifted",
  );
});

test("buffered: plain string content passes through untouched", () => {
  const body = {
    choices: [{ message: { role: "assistant", content: "plain" } }],
  };
  assert.deepEqual(liftBuffered(body), body);
});

test("buffered: a body without choices is untouched", () => {
  assert.deepEqual(liftBuffered({ error: { message: "x" } }), {
    error: { message: "x" },
  });
});

test("stream: thinking chunk emits reasoning_content, empty content", async () => {
  const events = await liftStream({
    choices: [
      {
        index: 0,
        delta: { index: 0, content: [think("We ")], finish_reason: null },
        finish_reason: null,
      },
    ],
  });
  const chunk = events[0] as ChatCompletionChunk;
  const delta = chunk.choices?.[0]?.delta as Record<string, unknown>;
  assert.equal(delta.reasoning_content, "We ");
  assert.equal(delta.content, "");
  // [DONE] passes through untouched.
  assert.equal(events[1], "data: [DONE]");
});

test("stream: consecutive thinking deltas concatenate across chunks", async () => {
  const first = await liftStream({
    choices: [{ delta: { content: [think("We")] }, finish_reason: null }],
  });
  const second = await liftStream({
    choices: [{ delta: { content: [think(" need more")] }, finish_reason: null }],
  });
  const d1 = (first[0] as ChatCompletionChunk).choices?.[0]?.delta as Record<
    string,
    unknown
  >;
  const d2 = (second[0] as ChatCompletionChunk).choices?.[0]?.delta as Record<
    string,
    unknown
  >;
  // Each SseEventTransform is stateless per chunk here; within ONE provider
  // stream the bridge concatenates. The per-chunk lift emits each part's text.
  assert.equal(d1.reasoning_content, "We");
  assert.equal(d2.reasoning_content, " need more");
});

test("stream: plain string delta passes through untouched", async () => {
  const body = { choices: [{ delta: { content: "hi" }, finish_reason: null }] };
  const events = await liftStream(body);
  assert.deepEqual(events[0], body);
});

test("stream: usage-only chunk (no choices) unchanged", async () => {
  const body = {
    choices: [
      {
        delta: {},
        finish_reason: "stop",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      },
    ],
  };
  const events = await liftStream(body);
  assert.deepEqual(events[0], body);
});

test("stream: mixed multi-part delta keeps non-thinking parts", async () => {
  const events = await liftStream({
    choices: [
      {
        delta: { content: [think("th"), text("5 cents")] },
        finish_reason: null,
      },
    ],
  });
  const delta = (events[0] as ChatCompletionChunk).choices?.[0]?.delta as Record<
    string,
    unknown
  >;
  assert.equal(delta.reasoning_content, "th");
  assert.deepEqual(delta.content, [text("5 cents")]);
});
