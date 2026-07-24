// SseUsageObserver tests. Per the format-route completeness audit, this had
// NO dedicated test before this — only indirectly touched by an engine-level
// streaming test that asserts on an error event, never on usage. Covers all
// three usage-nesting shapes it reads (top-level, .message.usage,
// .response.usage), the chars/4 fallback estimate, cached-token extraction,
// pass-through-verbatim behavior, and the optional debug capture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SseUsageObserver } from "./sse-usage";

// Feed a Transform a sequence of raw SSE text chunks and collect everything
// written back out, concatenated — used to assert pass-through-verbatim.
function feed(observer: SseUsageObserver, chunks: string[]): string {
  const out: Buffer[] = [];
  observer.on("data", (c: Buffer) => out.push(c));
  for (const c of chunks) observer.write(Buffer.from(c, "utf8"));
  return Buffer.concat(out).toString("utf8");
}

function sseLine(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// --- pass-through -------------------------------------------------------------

test("forwards every byte unchanged (pure observer, no rewriting)", () => {
  const o = new SseUsageObserver();
  const chunks = [
    sseLine({ choices: [{ delta: { content: "hi" } }] }),
    "data: [DONE]\n\n",
  ];
  const forwarded = feed(o, chunks);
  assert.equal(forwarded, chunks.join(""));
});

test("a malformed/non-JSON data line never throws or breaks the stream", () => {
  const o = new SseUsageObserver();
  assert.doesNotThrow(() => {
    feed(o, [
      "data: {not valid json\n\n",
      sseLine({ usage: { input_tokens: 1 } }),
    ]);
  });
  assert.equal(o.usage(0).input, 1);
});

test("a chunk split mid-line is buffered correctly across _transform calls", () => {
  const o = new SseUsageObserver();
  const full = sseLine({ usage: { input_tokens: 7, output_tokens: 3 } });
  const mid = Math.floor(full.length / 2);
  feed(o, [full.slice(0, mid), full.slice(mid)]);
  const usage = o.usage(0);
  assert.equal(usage.input, 7);
  assert.equal(usage.output, 3);
});

// --- usage: three nesting shapes ----------------------------------------------

test("reads top-level .usage (OpenAI Chat final chunk)", () => {
  const o = new SseUsageObserver();
  feed(o, [sseLine({ usage: { prompt_tokens: 10, completion_tokens: 5 } })]);
  const usage = o.usage(0);
  assert.equal(usage.input, 10);
  assert.equal(usage.output, 5);
});

test("reads .message.usage (Anthropic message_start/message_delta)", () => {
  const o = new SseUsageObserver();
  feed(o, [
    sseLine({
      type: "message_start",
      message: { usage: { input_tokens: 20, output_tokens: 0 } },
    }),
    sseLine({
      type: "message_delta",
      message: { usage: { output_tokens: 8 } },
    }),
  ]);
  const usage = o.usage(0);
  assert.equal(usage.input, 20);
  assert.equal(usage.output, 8);
});

test("reads .response.usage (OpenAI Responses response.completed)", () => {
  const o = new SseUsageObserver();
  feed(o, [
    sseLine({
      type: "response.completed",
      response: { usage: { input_tokens: 15, output_tokens: 6 } },
    }),
  ]);
  const usage = o.usage(0);
  assert.equal(usage.input, 15);
  assert.equal(usage.output, 6);
});

test("output is cumulative/one-shot: the MAX seen across multiple usage events wins", () => {
  const o = new SseUsageObserver();
  feed(o, [
    sseLine({ usage: { output_tokens: 3 } }),
    sseLine({ usage: { output_tokens: 9 } }),
    sseLine({ usage: { output_tokens: 5 } }), // lower than the max seen so far
  ]);
  assert.equal(o.usage(0).output, 9);
});

test("prefers input_tokens/output_tokens over prompt_tokens/completion_tokens when both appear on the same event", () => {
  const o = new SseUsageObserver();
  feed(o, [
    sseLine({
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        input_tokens: 99,
        output_tokens: 99,
      },
    }),
  ]);
  const usage = o.usage(0);
  assert.equal(usage.input, 99);
  assert.equal(usage.output, 99);
});

// --- cached tokens -------------------------------------------------------------

test("reads cached tokens via readCachedTokens (Anthropic + OpenAI shapes)", () => {
  const anthropic = new SseUsageObserver();
  feed(anthropic, [
    sseLine({
      usage: { input_tokens: 10, cache_read_input_tokens: 4 },
    }),
  ]);
  assert.equal(anthropic.usage(0).cached, 4);
  // Anthropic's input_tokens excludes cached; normalised to total = 10 + 4.
  assert.equal(anthropic.usage(0).input, 14);

  const openai = new SseUsageObserver();
  feed(openai, [
    sseLine({
      usage: {
        prompt_tokens: 10,
        prompt_tokens_details: { cached_tokens: 6 },
      },
    }),
  ]);
  assert.equal(openai.usage(0).cached, 6);
  // OpenAI's prompt_tokens already includes cached — no addition.
  assert.equal(openai.usage(0).input, 10);
});

test("cached is omitted from usage() when never reported", () => {
  const o = new SseUsageObserver();
  feed(o, [sseLine({ usage: { input_tokens: 10, output_tokens: 5 } })]);
  assert.equal(o.usage(0).cached, undefined);
});

// --- fallback estimate (no usage reported at all) -----------------------------

test("falls back to a chars/4 estimate of streamed text when no usage is ever reported", () => {
  const o = new SseUsageObserver();
  feed(o, [
    sseLine({ choices: [{ delta: { content: "12345678" } }] }), // 8 chars
    sseLine({ choices: [{ delta: { content: "1234" } }] }), // 4 chars
  ]);
  // 12 chars total -> ceil(12/4) = 3
  assert.equal(o.usage(0).output, 3);
});

test("upstream-reported output always wins over the fallback estimate", () => {
  const o = new SseUsageObserver();
  feed(o, [
    sseLine({ choices: [{ delta: { content: "a".repeat(400) } }] }), // would estimate to 100
    sseLine({ usage: { output_tokens: 5 } }),
  ]);
  assert.equal(o.usage(0).output, 5);
});

test("input falls back to the caller's pre-request estimate when nothing was reported", () => {
  const o = new SseUsageObserver();
  feed(o, [sseLine({ choices: [{ delta: { content: "hi" } }] })]);
  assert.equal(o.usage(42).input, 42);
});

test("fallback accumulates Responses-format string deltas too", () => {
  const o = new SseUsageObserver();
  feed(o, [
    sseLine({ type: "response.output_text.delta", delta: "12345678" }), // 8 chars
  ]);
  assert.equal(o.usage(0).output, 2); // ceil(8/4)
});

test("fallback accumulates Anthropic text/thinking deltas via the generic .delta object shape", () => {
  const o = new SseUsageObserver();
  feed(o, [
    sseLine({ type: "content_block_delta", delta: { text: "12345678" } }), // 8 chars
    sseLine({ type: "content_block_delta", delta: { thinking: "1234" } }), // 4 chars
  ]);
  assert.equal(o.usage(0).output, 3); // ceil(12/4)
});

// --- [DONE] / empty lines ------------------------------------------------------

test("[DONE] and blank data lines are skipped without error", () => {
  const o = new SseUsageObserver();
  assert.doesNotThrow(() => {
    feed(o, ["data: [DONE]\n\n", "data:\n\n", "data: \n\n"]);
  });
  assert.deepEqual(o.usage(0), { input: undefined, output: undefined });
});

// --- debug capture (off by default) --------------------------------------------

test("responseSummary() is null when capture is off (the default)", () => {
  const o = new SseUsageObserver();
  feed(o, [sseLine({ choices: [{ delta: { content: "hi" } }] })]);
  assert.equal(o.responseSummary(), null);
});

test("responseSummary() captures text, tool calls, and stop reason when capture:true", () => {
  const o = new SseUsageObserver({ capture: true });
  feed(o, [
    sseLine({
      choices: [
        {
          delta: {
            content: "hi",
            tool_calls: [
              { index: 0, function: { name: "search", arguments: '{"q":' } },
            ],
          },
        },
      ],
    }),
    sseLine({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '"x"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    }),
  ]);
  const summary = o.responseSummary();
  assert.ok(summary);
  assert.equal(summary!.text, "hi");
  assert.equal(summary!.toolCalls?.[0].name, "search");
  assert.equal(summary!.toolCalls?.[0].arguments, '{"q":"x"}');
  assert.equal(summary!.stopReason, "tool_calls");
});

test("responseSummary() captures Anthropic tool_use + thinking text via content_block events", () => {
  const o = new SseUsageObserver({ capture: true });
  feed(o, [
    sseLine({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", name: "search" },
    }),
    sseLine({
      type: "content_block_delta",
      index: 0,
      delta: { partial_json: '{"q":"x"}' },
    }),
    sseLine({
      type: "content_block_delta",
      delta: { thinking: "let me think" },
    }),
    sseLine({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
  ]);
  const summary = o.responseSummary();
  assert.ok(summary);
  assert.equal(summary!.text, "let me think");
  assert.equal(summary!.toolCalls?.[0].name, "search");
  assert.equal(summary!.toolCalls?.[0].arguments, '{"q":"x"}');
  assert.equal(summary!.stopReason, "tool_use");
});
