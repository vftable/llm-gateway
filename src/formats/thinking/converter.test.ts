// ThinkingConverter tests, focused on the empty-block elimination fix and
// the synthetic-signature emission on applyToAnthropicMessage. General
// extraction behavior is also covered indirectly via transforms.test.ts
// (the tagged-default parity tests); this file targets ThinkingConverter's
// own contract directly, including the parseThinking/parseThinkingRaw split
// this fix introduced.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ThinkingConverter } from "./converter";
import { SYNTHETIC_THINKING_SIGNATURE } from "../wire/anthropic";

const conv = new ThinkingConverter();

// --- parseThinking: empty-block filtering -----------------------------------

test("parseThinking: a normal block is returned trimmed", () => {
  assert.deepEqual(conv.parseThinking("<thinking>  hello  </thinking>"), [
    "hello",
  ]);
});

test("parseThinking: an empty <thinking></thinking> pair is dropped, not kept as ''", () => {
  assert.deepEqual(conv.parseThinking("<thinking></thinking>"), []);
});

test("parseThinking: a whitespace-only block is dropped", () => {
  assert.deepEqual(conv.parseThinking("<thinking>   \n  </thinking>"), []);
});

test("parseThinking: a mix of empty and real blocks keeps only the real ones", () => {
  assert.deepEqual(
    conv.parseThinking("<thinking></thinking><thinking>real</thinking>"),
    ["real"],
  );
});

test("parseThinking: no tags at all -> []", () => {
  assert.deepEqual(conv.parseThinking("plain text"), []);
});

// --- applyToAnthropicMessage: empty-block stripping + signature ------------

test("applyToAnthropicMessage: a real inline <thinking> tag becomes a thinking block with the synthetic signature", () => {
  const body = {
    content: [{ type: "text", text: "<thinking>plan</thinking>answer" }],
  };
  const out = conv.applyToAnthropicMessage(body)!;
  const blocks = out.content as Array<Record<string, unknown>>;
  const thinking = blocks.find((b) => b.type === "thinking")!;
  assert.equal(thinking.thinking, "plan");
  assert.equal(thinking.signature, SYNTHETIC_THINKING_SIGNATURE);
  const text = blocks.find((b) => b.type === "text")!;
  assert.equal(text.text, "answer");
});

test("applyToAnthropicMessage: a lone empty <thinking></thinking> tag is stripped, no thinking block emitted", () => {
  const body = {
    content: [{ type: "text", text: "<thinking></thinking>hello" }],
  };
  const out = conv.applyToAnthropicMessage(body)!;
  const blocks = out.content as Array<Record<string, unknown>>;
  assert.ok(!blocks.some((b) => b.type === "thinking"));
  const text = blocks.find((b) => b.type === "text")!;
  assert.equal(text.text, "hello");
});

test("applyToAnthropicMessage: an empty tag with NOTHING else in the text drops the text block too", () => {
  const body = { content: [{ type: "text", text: "<thinking></thinking>" }] };
  const out = conv.applyToAnthropicMessage(body)!;
  const blocks = out.content as Array<Record<string, unknown>>;
  assert.equal(blocks.length, 0);
});

test("applyToAnthropicMessage: multiple thinking blocks in one text part all get the signature", () => {
  const body = {
    content: [
      {
        type: "text",
        text: "<thinking>one</thinking>mid<thinking>two</thinking>end",
      },
    ],
  };
  const out = conv.applyToAnthropicMessage(body)!;
  const blocks = out.content as Array<Record<string, unknown>>;
  const thinkingBlocks = blocks.filter((b) => b.type === "thinking");
  assert.equal(thinkingBlocks.length, 2);
  assert.deepEqual(
    thinkingBlocks.map((b) => b.thinking),
    ["one", "two"],
  );
  assert.ok(
    thinkingBlocks.every((b) => b.signature === SYNTHETIC_THINKING_SIGNATURE),
  );
});

test("applyToAnthropicMessage: no thinking tags at all -> null (no-op)", () => {
  const body = { content: [{ type: "text", text: "plain" }] };
  assert.equal(conv.applyToAnthropicMessage(body), null);
});

test("applyToAnthropicMessage: non-text blocks (e.g. tool_use) pass through untouched", () => {
  const body = {
    content: [
      { type: "tool_use", id: "t1", name: "search", input: {} },
      { type: "text", text: "<thinking>plan</thinking>ok" },
    ],
  };
  const out = conv.applyToAnthropicMessage(body)!;
  const blocks = out.content as Array<Record<string, unknown>>;
  assert.deepEqual(blocks[0], {
    type: "tool_use",
    id: "t1",
    name: "search",
    input: {},
  });
});

test("applyToAnthropicMessage: an unclosed opening tag is stripped without emitting a thinking block", () => {
  const body = {
    content: [{ type: "text", text: "<thinking>stuck, never closes" }],
  };
  const out = conv.applyToAnthropicMessage(body)!;
  const blocks = out.content as Array<Record<string, unknown>>;
  assert.ok(!blocks.some((b) => b.type === "thinking"));
});

test("applyToAnthropicMessage: missing/malformed body -> null", () => {
  assert.equal(conv.applyToAnthropicMessage(undefined as never), null);
  assert.equal(conv.applyToAnthropicMessage({} as never), null);
  assert.equal(
    conv.applyToAnthropicMessage({ content: "not-an-array" } as never),
    null,
  );
});

// --- applyToChatCompletion: parity check (empty blocks never leak either) --

test("applyToChatCompletion: an empty thinking tag is stripped, reasoning fields stay absent", () => {
  const body = {
    choices: [
      { message: { role: "assistant", content: "<thinking></thinking>hi" } },
    ],
  };
  const out = conv.applyToChatCompletion(body)!;
  const msg = out.choices![0].message!;
  assert.equal(msg.content, "hi");
  assert.equal(msg.reasoning, undefined);
  assert.equal(msg.reasoning_details, undefined);
});

test("applyToChatCompletion: a real block sets reasoning + reasoning_details", () => {
  const body = {
    choices: [
      {
        message: { role: "assistant", content: "<thinking>plan</thinking>hi" },
      },
    ],
  };
  const out = conv.applyToChatCompletion(body)!;
  const msg = out.choices![0].message!;
  assert.equal(msg.content, "hi");
  assert.equal(msg.reasoning, "plan");
  assert.equal(msg.reasoning_details?.length, 1);
});

// --- applyToResponse: parity check ------------------------------------------

test("applyToResponse: an empty thinking tag never produces an empty reasoning output item", () => {
  const body = {
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "<thinking></thinking>hi" }],
      },
    ],
  };
  const out = conv.applyToResponse(body)!;
  const items = out.output as Array<Record<string, unknown>>;
  assert.ok(!items.some((i) => i.type === "reasoning"));
});

test("applyToResponse: a real block prepends exactly one reasoning output item", () => {
  const body = {
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "<thinking>plan</thinking>hi" }],
      },
    ],
  };
  const out = conv.applyToResponse(body)!;
  const items = out.output as Array<Record<string, unknown>>;
  assert.equal(items[0].type, "reasoning");
  const summary = items[0].summary as Array<{ text: string }>;
  assert.equal(summary[0].text, "plan");
});

// --- code block / inline code protection -----------------------------------

test("parseThinking: tags inside triple-backtick fences are NOT extracted", () => {
  const text = "```\n<thinking>fenced</thinking>\n```";
  assert.deepEqual(conv.parseThinking(text), []);
});

test("parseThinking: tags inside inline code spans are NOT extracted", () => {
  const text = "use `<thinking>example</thinking>` for reasoning";
  assert.deepEqual(conv.parseThinking(text), []);
});

test("stripThinking: unclosed <thinking> inside a code fence is preserved", () => {
  const text = "here\n```\n<thinking>\n```\nend";
  assert.equal(conv.stripThinking(text), text);
});

// --- looksLikeExample heuristic -------------------------------------------

test("parseThinking: mid-sentence prose before tag -> skipped as example", () => {
  assert.deepEqual(
    conv.parseThinking("Here is an example: <thinking>demo</thinking> ok"),
    [],
  );
});

test("parseThinking: preceded by colon -> skipped as example", () => {
  assert.deepEqual(
    conv.parseThinking("output: <thinking>example</thinking>"),
    [],
  );
});

test("parseThinking: at start of text, newline-separated -> extracted", () => {
  assert.deepEqual(
    conv.parseThinking("<thinking>real plan</thinking>\nthe answer"),
    ["real plan"],
  );
});
