import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOpenAIReasoning, toOpenAIEffort } from "./openai-reasoning";
import { messagesRequestToChat } from "../converters/chat-messages";

// --- toOpenAIEffort ---------------------------------------------------------

test("toOpenAIEffort maps aliases to canonical levels for GPT-5.6", () => {
  assert.equal(toOpenAIEffort("highest", "gpt-5.6"), "high");
  assert.equal(toOpenAIEffort("xhigh", "gpt-5.6"), "xhigh");
  assert.equal(toOpenAIEffort("x-high", "gpt-5.6"), "xhigh");
  assert.equal(toOpenAIEffort("extra-high", "gpt-5.6"), "xhigh");
  assert.equal(toOpenAIEffort("max", "gpt-5.6"), "max");
  assert.equal(toOpenAIEffort("maximum", "gpt-5.6"), "max");
  assert.equal(toOpenAIEffort("minimal", "gpt-5.6"), "low");
  assert.equal(toOpenAIEffort("min", "gpt-5.6"), "low");
  assert.equal(toOpenAIEffort("lowest", "gpt-5.6"), "low");
});

test("toOpenAIEffort clamps xhigh/max to high for older models", () => {
  assert.equal(toOpenAIEffort("xhigh", "gpt-4o"), "high");
  assert.equal(toOpenAIEffort("max", "gpt-4o"), "high");
  assert.equal(toOpenAIEffort("max", "o1"), "high");
});

test("toOpenAIEffort clamps max to xhigh for GPT-5 (non-5.6)", () => {
  assert.equal(toOpenAIEffort("xhigh", "gpt-5"), "xhigh");
  assert.equal(toOpenAIEffort("max", "gpt-5"), "xhigh");
  assert.equal(toOpenAIEffort("max", "gpt-5-pro"), "xhigh");
});

test("toOpenAIEffort defaults to high cap when model is unknown", () => {
  assert.equal(toOpenAIEffort("xhigh"), "high");
  assert.equal(toOpenAIEffort("max"), "high");
  assert.equal(toOpenAIEffort("high"), "high");
});

test("toOpenAIEffort passes through valid values unchanged", () => {
  assert.equal(toOpenAIEffort("low", "gpt-5.6"), "low");
  assert.equal(toOpenAIEffort("medium", "gpt-5.6"), "medium");
  assert.equal(toOpenAIEffort("high", "gpt-5.6"), "high");
  assert.equal(toOpenAIEffort("xhigh", "gpt-5"), "xhigh");
  assert.equal(toOpenAIEffort("max", "gpt-5.6"), "max");
});

test("toOpenAIEffort is case-insensitive", () => {
  assert.equal(toOpenAIEffort("HIGH", "gpt-5.6"), "high");
  assert.equal(toOpenAIEffort("XHIGH", "gpt-5.6"), "xhigh");
  assert.equal(toOpenAIEffort("MAX", "gpt-5.6"), "max");
  assert.equal(toOpenAIEffort("Medium", "gpt-5.6"), "medium");
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
  assert.equal(body.reasoning_effort, "xhigh");
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

// --- GLM / Z.AI reasoning_effort --------------------------------------------

const GLM_CONTEXT = { catalogId: "glm-coding" };

test("GLM-5.2 preserves documented positive efforts and enables thinking", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    const body: Record<string, unknown> = {
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: effort,
      thinking: { clear_thinking: false },
    };
    normalizeOpenAIReasoning(body, GLM_CONTEXT);
    assert.equal(body.reasoning_effort, effort);
    assert.deepEqual(body.thinking, {
      clear_thinking: false,
      type: "enabled",
    });
  }
});

test("GLM-5.2 normalizes effort aliases without GPT clamping", () => {
  const cases = [
    ["maximum", "max"],
    ["x-high", "xhigh"],
    ["extra_high", "xhigh"],
    ["highest", "high"],
  ] as const;
  for (const [input, expected] of cases) {
    const body: Record<string, unknown> = {
      model: "glm-5.2",
      messages: [],
      reasoning_effort: input,
    };
    normalizeOpenAIReasoning(body, GLM_CONTEXT);
    assert.equal(body.reasoning_effort, expected);
    assert.deepEqual(body.thinking, { type: "enabled" });
  }
});

test("GLM minimal/none aliases disable thinking and remove effort", () => {
  for (const effort of ["minimal", "none", "min", "lowest"]) {
    const body: Record<string, unknown> = {
      model: "glm-5.2",
      messages: [],
      reasoning_effort: effort,
      thinking: { clear_thinking: false },
    };
    normalizeOpenAIReasoning(body, GLM_CONTEXT);
    assert.equal(body.reasoning_effort, undefined);
    assert.deepEqual(body.thinking, {
      clear_thinking: false,
      type: "disabled",
    });
  }
});

test("GLM explicit thinking disable wins over a positive effort", () => {
  const body: Record<string, unknown> = {
    model: "glm-5.2",
    messages: [],
    reasoning_effort: "max",
    thinking: { type: "disabled", clear_thinking: false },
  };
  normalizeOpenAIReasoning(body, GLM_CONTEXT);
  assert.equal(body.reasoning_effort, undefined);
  assert.deepEqual(body.thinking, {
    type: "disabled",
    clear_thinking: false,
  });
});

test("pre-5.2 GLM translates effort to thinking toggle but strips unsupported field", () => {
  const enabled: Record<string, unknown> = {
    model: "glm-5.1",
    messages: [],
    reasoning_effort: "high",
  };
  normalizeOpenAIReasoning(enabled, GLM_CONTEXT);
  assert.equal(enabled.reasoning_effort, undefined);
  assert.deepEqual(enabled.thinking, { type: "enabled" });

  const disabled: Record<string, unknown> = {
    model: "glm-4.7",
    messages: [],
    reasoning_effort: "none",
  };
  normalizeOpenAIReasoning(disabled, GLM_CONTEXT);
  assert.equal(disabled.reasoning_effort, undefined);
  assert.deepEqual(disabled.thinking, { type: "disabled" });
});

test("GLM request without effort preserves native thinking config", () => {
  const body: Record<string, unknown> = {
    model: "glm-5.2",
    messages: [],
    thinking: { type: "enabled", clear_thinking: false },
  };
  normalizeOpenAIReasoning(body, GLM_CONTEXT);
  assert.deepEqual(body.thinking, {
    type: "enabled",
    clear_thinking: false,
  });
});

test("GLM-named model outside Z.AI keeps generic OpenAI clamping", () => {
  const body: Record<string, unknown> = {
    model: "glm-5.2",
    messages: [],
    reasoning_effort: "max",
  };
  normalizeOpenAIReasoning(body, { catalogId: "openrouter" });
  assert.equal(body.reasoning_effort, "high");
  assert.equal(body.thinking, undefined);
});

test("Messages conversion preserves large budget as GLM max before final normalization", () => {
  const converted = messagesRequestToChat({
    model: "glm-5.2",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 100000,
    thinking: { type: "enabled", budget_tokens: 70000 },
  });
  assert.equal(converted.reasoning_effort, "max");
  normalizeOpenAIReasoning(converted as Record<string, unknown>, GLM_CONTEXT);
  assert.equal(converted.reasoning_effort, "max");
  assert.deepEqual((converted as Record<string, unknown>).thinking, {
    type: "enabled",
  });
});

// --- normalizeOpenAIReasoning (Responses) ------------------------------------

test("Responses: normalizes reasoning.effort and defaults reasoning.summary", () => {
  const body: Record<string, unknown> = {
    model: "gpt-5.6",
    input: "hi",
    reasoning: { effort: "max" },
  };
  normalizeOpenAIReasoning(body);
  const r = body.reasoning as { effort: unknown; summary: unknown };
  assert.equal(r.effort, "max");
  assert.equal(r.summary, "detailed");
});

test("Responses: clamps max to xhigh for GPT-5", () => {
  const body: Record<string, unknown> = {
    model: "gpt-5",
    input: "hi",
    reasoning: { effort: "max" },
  };
  normalizeOpenAIReasoning(body);
  const r = body.reasoning as { effort: unknown };
  assert.equal(r.effort, "xhigh");
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

// --- GPT-5.6+ reasoning content stripping ----------------------------------

test("Responses: GPT-5.6 strips content from reasoning input items, keeps summary", () => {
  const body: Record<string, unknown> = {
    model: "gpt-5.6",
    input: [
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "gAAAA_opaque",
        summary: [{ type: "summary_text", text: "thought" }],
        content: [{ type: "summary_text", text: "decrypted thinking" }],
      },
    ],
  };
  normalizeOpenAIReasoning(body);
  const items = body.input as Array<Record<string, unknown>>;
  const r = items[0];
  assert.equal(r.content, undefined);
  assert.equal(r.encrypted_content, "gAAAA_opaque");
  assert.deepEqual(r.summary, [{ type: "summary_text", text: "thought" }]);
});

test("Responses: GPT-5.6-sol also strips content from reasoning input items", () => {
  const body: Record<string, unknown> = {
    model: "gpt-5.6-sol",
    input: [
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "gAAAA_blob",
        summary: [{ type: "summary_text", text: "ok" }],
        content: [{ type: "summary_text", text: "private" }],
      },
    ],
  };
  normalizeOpenAIReasoning(body);
  const items = body.input as Array<Record<string, unknown>>;
  assert.equal(items[0].content, undefined);
  assert.equal(items[0].encrypted_content, "gAAAA_blob");
});

test("Responses: GPT-5 (non-5.6) still copies summary to content", () => {
  const body: Record<string, unknown> = {
    model: "gpt-5",
    input: [
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "gAAAA_blob",
        summary: [{ type: "summary_text", text: "step" }],
        content: [],
      },
    ],
  };
  normalizeOpenAIReasoning(body);
  const items = body.input as Array<Record<string, unknown>>;
  assert.equal(items[0].encrypted_content, undefined);
  assert.deepEqual(items[0].content, [{ type: "summary_text", text: "step" }]);
});
