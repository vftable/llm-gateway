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

test("Responses: preserves summary but never forwards reasoning content", () => {
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
  assert.equal(reasoning.content, undefined);
  assert.deepEqual(reasoning.summary, [
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
  assert.equal(items[0].content, undefined);
  assert.deepEqual(items[0].summary, [
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
  assert.equal(r.encrypted_content, undefined);
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
  assert.equal(items[0].encrypted_content, undefined);
});

test("Responses: codex-auto-review always strips content and preserves summary", () => {
  const body: Record<string, unknown> = {
    model: "codex-auto-review",
    input: [
      {
        type: "reasoning",
        id: "rs_review",
        encrypted_content: "provider-specific",
        summary: [{ type: "summary_text", text: "review summary" }],
        content: [{ type: "summary_text", text: "private reasoning" }],
      },
    ],
  };
  normalizeOpenAIReasoning(body);
  const item = (body.input as Array<Record<string, unknown>>)[0];
  assert.equal(item.content, undefined);
  assert.equal(item.encrypted_content, undefined);
  assert.deepEqual(item.summary, [
    { type: "summary_text", text: "review summary" },
  ]);
});

// --- DeepSeek reasoner -------------------------------------------------------

const DEEPSEEK_CONTEXT = { catalogId: "deepseek" };

test("DeepSeek reasoner defaults thinking to enabled for reasoner models", () => {
  const body: Record<string, unknown> = {
    model: "deepseek-reasoner",
    messages: [{ role: "user", content: "hi" }],
  };
  normalizeOpenAIReasoning(body, DEEPSEEK_CONTEXT);
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body._thinking_disabled, undefined);
});

test("DeepSeek reasoner respects _thinking_disabled signal from Messages→Chat", () => {
  const body: Record<string, unknown> = {
    model: "deepseek-reasoner",
    messages: [{ role: "user", content: "hi" }],
    _thinking_disabled: true,
  };
  normalizeOpenAIReasoning(body, DEEPSEEK_CONTEXT);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body._thinking_disabled, undefined);
});

test("DeepSeek reasoner _thinking_disabled false → thinking enabled", () => {
  const body: Record<string, unknown> = {
    model: "deepseek-reasoner",
    messages: [{ role: "user", content: "hi" }],
    _thinking_disabled: false,
  };
  normalizeOpenAIReasoning(body, DEEPSEEK_CONTEXT);
  assert.deepEqual(body.thinking, { type: "enabled" });
});

test("DeepSeek reasoner preserves existing thinking object, normalizing type", () => {
  const body: Record<string, unknown> = {
    model: "deepseek-reasoner",
    messages: [],
    thinking: { type: "disabled", clear_thinking: false },
  };
  normalizeOpenAIReasoning(body, DEEPSEEK_CONTEXT);
  assert.deepEqual(body.thinking, { type: "disabled", clear_thinking: false });
});

test("DeepSeek reasoner: low / minimal / none → thinking disabled, effort removed", () => {
  for (const effort of ["low", "minimal", "none", "lowest", "min"]) {
    const body: Record<string, unknown> = {
      model: "deepseek-reasoner",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: effort,
    };
    normalizeOpenAIReasoning(body, DEEPSEEK_CONTEXT);
    assert.equal(body.reasoning_effort, undefined, `effort=${effort}`);
    assert.deepEqual(body.thinking, { type: "disabled" }, `effort=${effort}`);
  }
});

test("DeepSeek reasoner: medium → high, thinking enabled", () => {
  const body: Record<string, unknown> = {
    model: "deepseek-reasoner",
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "medium",
  };
  normalizeOpenAIReasoning(body, DEEPSEEK_CONTEXT);
  assert.equal(body.reasoning_effort, "high");
  assert.deepEqual(body.thinking, { type: "enabled" });
});

test("DeepSeek reasoner: xhigh / x-high / extra-high / extra_high → max", () => {
  for (const alias of ["xhigh", "x-high", "extra-high", "extra_high"]) {
    const body: Record<string, unknown> = {
      model: "deepseek-reasoner",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: alias,
    };
    normalizeOpenAIReasoning(body, DEEPSEEK_CONTEXT);
    assert.equal(body.reasoning_effort, "max", `alias=${alias}`);
    assert.deepEqual(body.thinking, { type: "enabled" }, `alias=${alias}`);
  }
});

test("DeepSeek reasoner preserves high/max effort", () => {
  for (const effort of ["high", "max"]) {
    const body: Record<string, unknown> = {
      model: "deepseek-reasoner",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: effort,
    };
    normalizeOpenAIReasoning(body, DEEPSEEK_CONTEXT);
    assert.equal(body.reasoning_effort, effort);
    assert.deepEqual(body.thinking, { type: "enabled" });
  }
});

test("DeepSeek reasoner: 'highest' → high, 'maximum' → max", () => {
  const bodyHigh: Record<string, unknown> = {
    model: "deepseek-reasoner",
    messages: [],
    reasoning_effort: "highest",
  };
  normalizeOpenAIReasoning(bodyHigh, DEEPSEEK_CONTEXT);
  assert.equal(bodyHigh.reasoning_effort, "high");

  const bodyMax: Record<string, unknown> = {
    model: "deepseek-reasoner",
    messages: [],
    reasoning_effort: "maximum",
  };
  normalizeOpenAIReasoning(bodyMax, DEEPSEEK_CONTEXT);
  assert.equal(bodyMax.reasoning_effort, "max");
});

test("DeepSeek reasoner: strips unsupported fields and sampling params when thinking enabled", () => {
  const body: Record<string, unknown> = {
    model: "deepseek-reasoner",
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.7,
    top_p: 0.9,
    presence_penalty: 0.5,
    frequency_penalty: 0.3,
    top_k: 40,
    seed: 42,
    parallel_tool_calls: true,
    max_tokens: 1000,
    stream: true,
  };
  normalizeOpenAIReasoning(body, DEEPSEEK_CONTEXT);
  // Stripped when thinking is enabled (no effect per DeepSeek docs).
  assert.equal(body.temperature, undefined);
  assert.equal(body.top_p, undefined);
  // Always stripped (deprecated / not in DeepSeek API).
  assert.equal(body.presence_penalty, undefined);
  assert.equal(body.frequency_penalty, undefined);
  assert.equal(body.top_k, undefined);
  assert.equal(body.seed, undefined);
  assert.equal(body.parallel_tool_calls, undefined);
  // Accepted params survive.
  assert.equal(body.max_tokens, 1000);
  assert.equal(body.stream, true);
});

test("DeepSeek reasoner: deprecated fields stripped even when thinking disabled", () => {
  const body: Record<string, unknown> = {
    model: "deepseek-reasoner",
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "low",
    top_k: 40,
    frequency_penalty: 0.3,
    presence_penalty: 0.5,
    seed: 42,
    parallel_tool_calls: false,
    temperature: 0.7,
    top_p: 0.9,
  };
  normalizeOpenAIReasoning(body, DEEPSEEK_CONTEXT);
  // Always stripped (deprecated / not in DeepSeek API).
  assert.equal(body.top_k, undefined);
  assert.equal(body.frequency_penalty, undefined);
  assert.equal(body.presence_penalty, undefined);
  assert.equal(body.seed, undefined);
  assert.equal(body.parallel_tool_calls, undefined);
  assert.equal(body.reasoning_effort, undefined);
  assert.deepEqual(body.thinking, { type: "disabled" });
  // temperature and top_p preserved when thinking is disabled.
  assert.equal(body.temperature, 0.7);
  assert.equal(body.top_p, 0.9);
});

test("DeepSeek reasoner: max_completion_tokens normalised to max_tokens", () => {
  const body: Record<string, unknown> = {
    model: "deepseek-reasoner",
    messages: [{ role: "user", content: "hi" }],
    max_completion_tokens: 4096,
  };
  normalizeOpenAIReasoning(body, DEEPSEEK_CONTEXT);
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.max_completion_tokens, undefined);
});

test("DeepSeek reasoner: max_completion_tokens wins over max_tokens when both present", () => {
  const body: Record<string, unknown> = {
    model: "deepseek-reasoner",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 2048,
    max_completion_tokens: 8192,
  };
  normalizeOpenAIReasoning(body, DEEPSEEK_CONTEXT);
  assert.equal(body.max_tokens, 8192);
  assert.equal(body.max_completion_tokens, undefined);
});

test("DeepSeek reasoner: low effort overrides _thinking_disabled=false", () => {
  const body: Record<string, unknown> = {
    model: "deepseek-reasoner",
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "low",
    _thinking_disabled: false,
  };
  normalizeOpenAIReasoning(body, DEEPSEEK_CONTEXT);
  assert.equal(body.reasoning_effort, undefined);
  assert.deepEqual(body.thinking, { type: "disabled" });
});

test("DeepSeek v4 model family is recognized as a reasoner", () => {
  for (const model of ["deepseek-v4", "deepseek-v4-pro"]) {
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
    };
    normalizeOpenAIReasoning(body, DEEPSEEK_CONTEXT);
    assert.deepEqual(body.thinking, { type: "enabled" }, model);
    assert.equal(body.reasoning_effort, "high", model);
    assert.equal(body.temperature, undefined, model);
  }
});

test("DeepSeek provider with non-reasoner model goes through standard OpenAI path", () => {
  const body: Record<string, unknown> = {
    model: "deepseek-chat",
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "max",
    temperature: 0.5,
    _thinking_disabled: true,
  };
  normalizeOpenAIReasoning(body, DEEPSEEK_CONTEXT);
  // Standard OpenAI path clamps max to high for non-GPT-5 models.
  assert.equal(body.reasoning_effort, "high");
  // Standard path does NOT strip temperature.
  assert.equal(body.temperature, 0.5);
  // Standard path strips the gateway-internal thinking signal.
  assert.equal(body._thinking_disabled, undefined);
  assert.equal(body.thinking, undefined);
});

test("DeepSeek reasoner model outside DeepSeek provider keeps generic OpenAI behavior", () => {
  const body: Record<string, unknown> = {
    model: "deepseek-reasoner",
    messages: [],
    reasoning_effort: "max",
    temperature: 0.5,
    _thinking_disabled: true,
  };
  normalizeOpenAIReasoning(body, { catalogId: "openrouter" });
  // Generic path clamps max to high.
  assert.equal(body.reasoning_effort, "high");
  // Generic path does NOT strip temperature.
  assert.equal(body.temperature, 0.5);
  // Generic path strips thinking and _thinking_disabled.
  assert.equal(body._thinking_disabled, undefined);
  assert.equal(body.thinking, undefined);
});

test("DeepSeek reasoner strips _reasoning_summary and Anthropic metadata", () => {
  const body: Record<string, unknown> = {
    model: "deepseek-reasoner",
    messages: [],
    _reasoning_summary: "detailed",
    metadata: { user_id: "test" },
  };
  normalizeOpenAIReasoning(body, DEEPSEEK_CONTEXT);
  assert.equal(body._reasoning_summary, undefined);
  assert.equal(body.metadata, undefined);
});

// --- Generic path strips thinking from unsupporting providers ---------------

test("Generic chat path strips thinking and _thinking_disabled", () => {
  const body: Record<string, unknown> = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "enabled" },
    _thinking_disabled: false,
    reasoning_effort: "high",
  };
  normalizeOpenAIReasoning(body);
  assert.equal(body._thinking_disabled, undefined);
  assert.equal(body.thinking, undefined);
  assert.equal(body.reasoning_effort, "high");
});

test("Generic chat path strips any thinking object, including Anthropic-shaped", () => {
  const body: Record<string, unknown> = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "enabled", budget_tokens: 16000 },
    reasoning_effort: "high",
  };
  normalizeOpenAIReasoning(body);
  // Both _thinking_disabled and ANY thinking object are stripped on the generic
  // path — only DeepSeek and GLM support the toggle; OpenAI 400s on it.
  assert.equal(body._thinking_disabled, undefined);
  assert.equal(body.thinking, undefined);
});

// --- GLM _thinking_disabled signal -------------------------------------------

test("GLM _thinking_disabled disables thinking even without reasoning_effort", () => {
  const body: Record<string, unknown> = {
    model: "glm-5.2",
    messages: [],
    _thinking_disabled: true,
  };
  normalizeOpenAIReasoning(body, GLM_CONTEXT);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body._thinking_disabled, undefined);
});

test("GLM _thinking_disabled + effort composes into disabled thinking", () => {
  const body: Record<string, unknown> = {
    model: "glm-5.2",
    messages: [],
    reasoning_effort: "max",
    _thinking_disabled: true,
  };
  normalizeOpenAIReasoning(body, GLM_CONTEXT);
  assert.equal(body.reasoning_effort, undefined);
  assert.deepEqual(body.thinking, { type: "disabled" });
});

test("Responses: GPT-5 strips content and encrypted_content, keeps summary", () => {
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
  assert.equal(items[0].content, undefined);
  assert.deepEqual(items[0].summary, [{ type: "summary_text", text: "step" }]);
});
