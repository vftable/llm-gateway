// Token counting + usage extraction tests. Per the format-route completeness
// audit, tokens.ts had NO direct unit test before this — it was only
// exercised indirectly through an engine-level chat->chat request, which
// asserts the request succeeds but never checks the numbers. These tests
// cover all three request-body shapes (Anthropic Messages, OpenAI Chat,
// OpenAI Responses) and all three response usage shapes.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countTextTokens,
  countInputTokens,
  readMaxOutputTokens,
  readResponseUsage,
  readCachedTokens,
} from "./tokens";

// --- countTextTokens ---------------------------------------------------------

test("countTextTokens: ~4 chars/token, empty string is 0", () => {
  assert.equal(countTextTokens(""), 0);
  assert.equal(countTextTokens("abcd"), 1);
  assert.equal(countTextTokens("abcdefgh"), 2);
  assert.equal(countTextTokens("abc"), 1); // ceil(3/4) = 1
});

// --- countInputTokens: path-based dispatch -----------------------------------

test("countInputTokens: unrecognised path or non-object body returns 0", () => {
  assert.equal(countInputTokens({ messages: [] }, "/v1/unknown"), 0);
  assert.equal(countInputTokens(null, "/v1/chat/completions"), 0);
  assert.equal(countInputTokens("not an object", "/v1/chat/completions"), 0);
});

test("countInputTokens: Anthropic /v1/messages counts system + messages + tools", () => {
  const body = {
    system: "be terse", // 8 chars -> 2 tokens
    messages: [
      { role: "user", content: "hello there" }, // 11 chars -> 3 tokens + 4 overhead
    ],
    tools: [{ name: "search", input_schema: { type: "object" } }],
  };
  const n = countInputTokens(body, "/v1/messages");
  // system(2) + overhead(4) + content(3) + tool JSON tokens > 0
  assert.ok(n > 2 + 4 + 3, `expected tool tokens to add on top, got ${n}`);
});

test("countInputTokens: Anthropic tool_use/tool_result content parts are counted", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", input: { q: "weather in nyc" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", content: "sunny, 72F" }],
      },
    ],
  };
  const n = countInputTokens(body, "/v1/messages");
  assert.ok(n > 0);
});

test("countInputTokens: OpenAI /v1/chat/completions counts messages + tool_calls + tools", () => {
  const body = {
    messages: [
      { role: "user", content: "hello there" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "search", arguments: "{}" },
          },
        ],
      },
    ],
    tools: [{ type: "function", function: { name: "search" } }],
  };
  const n = countInputTokens(body, "/v1/chat/completions");
  assert.ok(n > 0);
});

test("countInputTokens: OpenAI /v1/responses counts instructions + string input", () => {
  const body = { instructions: "be terse", input: "hello there" };
  const n = countInputTokens(body, "/v1/responses");
  assert.ok(n > 0);
});

test("countInputTokens: OpenAI /v1/responses counts item-array input (message/function_call/function_call_output)", () => {
  const body = {
    input: [
      { type: "message", role: "user", content: "search it" },
      {
        type: "function_call",
        call_id: "c1",
        name: "search",
        arguments: '{"q":"x"}',
      },
      { type: "function_call_output", call_id: "c1", output: "result text" },
    ],
  };
  const n = countInputTokens(body, "/v1/responses");
  assert.ok(n > 0);
});

test("countInputTokens: path with a query string still dispatches correctly", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };
  const n = countInputTokens(body, "/v1/chat/completions?foo=bar");
  assert.ok(n > 0);
});

test("countInputTokens: never throws on malformed content", () => {
  const body = { messages: [{ role: "user", content: { weird: "shape" } }] };
  assert.doesNotThrow(() => countInputTokens(body, "/v1/chat/completions"));
});

// --- readMaxOutputTokens -----------------------------------------------------

test("readMaxOutputTokens: reads max_tokens (Anthropic), max_completion_tokens and max_output_tokens (OpenAI)", () => {
  assert.equal(readMaxOutputTokens({ max_tokens: 100 }), 100);
  assert.equal(readMaxOutputTokens({ max_completion_tokens: 200 }), 200);
  assert.equal(readMaxOutputTokens({ max_output_tokens: 300 }), 300);
  assert.equal(readMaxOutputTokens({}), undefined);
});

test("readMaxOutputTokens: max_tokens takes precedence when multiple are present", () => {
  assert.equal(
    readMaxOutputTokens({ max_tokens: 100, max_completion_tokens: 200 }),
    100,
  );
});

// --- readResponseUsage --------------------------------------------------------

test("readResponseUsage: OpenAI Chat shape (prompt_tokens/completion_tokens)", () => {
  const usage = readResponseUsage({
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  assert.deepEqual(usage, { input: 10, output: 5 });
});

test("readResponseUsage: Anthropic/Responses shape (input_tokens/output_tokens)", () => {
  const usage = readResponseUsage({
    usage: { input_tokens: 20, output_tokens: 8 },
  });
  assert.deepEqual(usage, { input: 20, output: 8 });
});

test("readResponseUsage: input_tokens/output_tokens override prompt_tokens/completion_tokens when both present", () => {
  const usage = readResponseUsage({
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      input_tokens: 20,
      output_tokens: 8,
    },
  });
  assert.deepEqual(usage, { input: 20, output: 8 });
});

test("readResponseUsage: no usage field / non-object body -> {}", () => {
  assert.deepEqual(readResponseUsage({}), {});
  assert.deepEqual(readResponseUsage(null), {});
  assert.deepEqual(readResponseUsage("not an object"), {});
  assert.deepEqual(readResponseUsage({ usage: "not an object" }), {});
});

test("readResponseUsage: Anthropic cached tokens folded into input total", () => {
  const usage = readResponseUsage({
    usage: {
      input_tokens: 20,
      output_tokens: 8,
      cache_read_input_tokens: 15,
    },
  });
  // input = input_tokens + cache_read_input_tokens = 35 (total including cached).
  // computeCostUsd subtracts cached from input to derive the uncached billable
  // portion, so input must include cached or the subtraction double-counts.
  assert.deepEqual(usage, { input: 35, output: 8, cached: 15 });
});

test("readResponseUsage: OpenAI cached tokens already included in prompt_tokens", () => {
  const usage = readResponseUsage({
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 60 },
    },
  });
  // prompt_tokens already includes cached — no addition needed.
  assert.deepEqual(usage, { input: 100, output: 20, cached: 60 });
});

// --- readCachedTokens ---------------------------------------------------------

test("readCachedTokens: Anthropic cache_read_input_tokens", () => {
  assert.equal(readCachedTokens({ cache_read_input_tokens: 42 }), 42);
});

test("readCachedTokens: OpenAI prompt_tokens_details.cached_tokens (Chat)", () => {
  assert.equal(
    readCachedTokens({ prompt_tokens_details: { cached_tokens: 30 } }),
    30,
  );
});

test("readCachedTokens: OpenAI input_tokens_details.cached_tokens (Responses)", () => {
  assert.equal(
    readCachedTokens({ input_tokens_details: { cached_tokens: 25 } }),
    25,
  );
});

test("readCachedTokens: absent -> null", () => {
  assert.equal(readCachedTokens({}), null);
  assert.equal(readCachedTokens({ prompt_tokens_details: {} }), null);
});
