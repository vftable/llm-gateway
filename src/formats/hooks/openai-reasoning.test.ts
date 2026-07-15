import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOpenAIReasoning, toOpenAIEffort } from "./openai-reasoning";

// --- toOpenAIEffort ---------------------------------------------------------

test("toOpenAIEffort maps Anthropic-only values to the closest OpenAI level", () => {
  assert.equal(toOpenAIEffort("xhigh"), "high");
  assert.equal(toOpenAIEffort("max"), "high");
  assert.equal(toOpenAIEffort("maximum"), "high");
  assert.equal(toOpenAIEffort("highest"), "high");
  assert.equal(toOpenAIEffort("x-high"), "high");
  assert.equal(toOpenAIEffort("extra-high"), "high");
  assert.equal(toOpenAIEffort("minimal"), "low");
  assert.equal(toOpenAIEffort("min"), "low");
  assert.equal(toOpenAIEffort("lowest"), "low");
});

test("toOpenAIEffort passes through valid OpenAI values unchanged", () => {
  assert.equal(toOpenAIEffort("low"), "low");
  assert.equal(toOpenAIEffort("medium"), "medium");
  assert.equal(toOpenAIEffort("high"), "high");
});

test("toOpenAIEffort is case-insensitive", () => {
  assert.equal(toOpenAIEffort("HIGH"), "high");
  assert.equal(toOpenAIEffort("XHIGH"), "high");
  assert.equal(toOpenAIEffort("Medium"), "medium");
});

test("toOpenAIEffort returns undefined for non-string / unknown values", () => {
  assert.equal(toOpenAIEffort(42), undefined);
  assert.equal(toOpenAIEffort(null), undefined);
  assert.equal(toOpenAIEffort("turbo"), undefined);
});

// --- normalizeOpenAIReasoning (Chat) ----------------------------------------

test("Chat: normalizes reasoning_effort and strips _reasoning_summary", () => {
  const body: Record<string, unknown> = {
    model: "gpt-5",
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "xhigh",
    _reasoning_summary: "detailed",
  };
  normalizeOpenAIReasoning(body);
  assert.equal(body.reasoning_effort, "high");
  assert.equal(body._reasoning_summary, undefined);
});

test("Chat: strips _reasoning_summary even without reasoning_effort", () => {
  const body: Record<string, unknown> = {
    model: "gpt-5",
    messages: [{ role: "user", content: "hi" }],
    _reasoning_summary: "concise",
  };
  normalizeOpenAIReasoning(body);
  assert.equal(body._reasoning_summary, undefined);
});

test("Chat: no-op when reasoning_effort is absent", () => {
  const body: Record<string, unknown> = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
  };
  const before = JSON.stringify(body);
  normalizeOpenAIReasoning(body);
  assert.equal(JSON.stringify(body), before);
});

// --- normalizeOpenAIReasoning (Responses) ------------------------------------

test("Responses: normalizes reasoning.effort and defaults reasoning.summary", () => {
  const body: Record<string, unknown> = {
    model: "gpt-5",
    input: "hi",
    reasoning: { effort: "max" },
  };
  normalizeOpenAIReasoning(body);
  const r = body.reasoning as { effort: unknown; summary: unknown };
  assert.equal(r.effort, "high");
  assert.equal(r.summary, "detailed");
});

test("Responses: preserves explicit reasoning.summary", () => {
  const body: Record<string, unknown> = {
    model: "gpt-5",
    input: "hi",
    reasoning: { effort: "high", summary: "concise" },
  };
  normalizeOpenAIReasoning(body);
  const r = body.reasoning as { effort: unknown; summary: unknown };
  assert.equal(r.summary, "concise");
});

test("Responses: no-op when reasoning is absent", () => {
  const body: Record<string, unknown> = {
    model: "gpt-4o",
    input: "hi",
  };
  const before = JSON.stringify(body);
  normalizeOpenAIReasoning(body);
  assert.equal(JSON.stringify(body), before);
});

test("Responses: no-op when reasoning.effort is absent", () => {
  const body: Record<string, unknown> = {
    model: "gpt-5",
    input: "hi",
    reasoning: { summary: "auto" },
  };
  normalizeOpenAIReasoning(body);
  const r = body.reasoning as { summary: unknown };
  assert.equal(r.summary, "auto");
});

// --- input reasoning item sanitization --------------------------------------

test("Responses: strips encrypted_content from reasoning input items", () => {
  const body: Record<string, unknown> = {
    model: "gpt-5",
    input: [
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "gAAAA_opaque_blob",
        summary: [{ type: "summary_text", text: "thinking about it" }],
        content: [],
      },
      { type: "message", role: "user", content: "hi" },
    ],
  };
  normalizeOpenAIReasoning(body);
  const items = body.input as Array<Record<string, unknown>>;
  const reasoning = items.find((i) => i.type === "reasoning")!;
  assert.equal(reasoning.encrypted_content, undefined);
});

test("Responses: converts summary text to content blocks on reasoning input items", () => {
  const body: Record<string, unknown> = {
    model: "gpt-5",
    input: [
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "gAAAA_blob",
        summary: [
          { type: "summary_text", text: "step one" },
          { type: "summary_text", text: "step two" },
        ],
        content: [],
      },
    ],
  };
  normalizeOpenAIReasoning(body);
  const items = body.input as Array<Record<string, unknown>>;
  const reasoning = items[0];
  assert.deepEqual(reasoning.content, [
    { type: "summary_text", text: "step one" },
    { type: "summary_text", text: "step two" },
  ]);
});

test("Responses: leaves non-reasoning input items untouched", () => {
  const msg = { type: "message", role: "user", content: "hi" };
  const body: Record<string, unknown> = {
    model: "gpt-5",
    input: [msg],
  };
  normalizeOpenAIReasoning(body);
  const items = body.input as Array<Record<string, unknown>>;
  assert.deepEqual(items[0], msg);
});

test("Responses: sanitizes reasoning items even when reasoning config is absent", () => {
  const body: Record<string, unknown> = {
    model: "gpt-5",
    input: [
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "gAAAA_blob",
        summary: [{ type: "summary_text", text: "thought" }],
        content: [],
      },
    ],
  };
  normalizeOpenAIReasoning(body);
  const items = body.input as Array<Record<string, unknown>>;
  assert.equal(items[0].encrypted_content, undefined);
  assert.deepEqual(items[0].content, [
    { type: "summary_text", text: "thought" },
  ]);
});
