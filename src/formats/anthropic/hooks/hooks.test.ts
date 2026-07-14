// Anthropic request-hook tests: thinking-config normalization, max_tokens
// clamp, the composed stack, and that it fires on the converted (chat->messages)
// body — plus hosted-tool pass-through.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeThinkingConfig } from "./thinking-config";
import { clampMaxTokens } from "./max-tokens";
import { defaultAnthropicRequestHooks } from "./stack";
import { chatRequestToMessages } from "../../converters/chat-messages";
import type { TransformCtx } from "../../pipeline";

function ctx(over: Partial<TransformCtx> = {}): TransformCtx {
  return {
    provider: { id: "p" } as never,
    clientFmt: "messages",
    providerFmt: "messages",
    upstreamModel: "claude-opus-4-8",
    maxOutputTokens: null,
    ...over,
  };
}

// --- thinking-config -------------------------------------------------------

test("thinking-config: adaptive downgrades to enabled on Haiku", () => {
  const body = normalizeThinkingConfig(
    { max_tokens: 20000, thinking: { type: "adaptive" } },
    "claude-haiku-4-5",
  );
  assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 10000 });
});

test("thinking-config: adaptive is left alone on non-Haiku", () => {
  const body = normalizeThinkingConfig(
    { max_tokens: 20000, thinking: { type: "adaptive" } },
    "claude-opus-4-8",
  );
  assert.deepEqual(body.thinking, { type: "adaptive" });
});

test("thinking-config: raises max_tokens when budget >= max_tokens", () => {
  const body = normalizeThinkingConfig(
    { max_tokens: 4000, thinking: { type: "enabled", budget_tokens: 8000 } },
    "claude-opus-4-8",
  );
  // budget stays; max_tokens raised to budget + 1024.
  assert.equal(
    (body.thinking as { budget_tokens: number }).budget_tokens,
    8000,
  );
  assert.equal(body.max_tokens, 9024);
});

test("thinking-config: floors budget_tokens to 1024", () => {
  const body = normalizeThinkingConfig(
    { max_tokens: 5000, thinking: { type: "enabled", budget_tokens: 100 } },
    "claude-opus-4-8",
  );
  assert.equal(
    (body.thinking as { budget_tokens: number }).budget_tokens,
    1024,
  );
});

test("thinking-config: hoists mid-conversation system messages into system", () => {
  const body = normalizeThinkingConfig(
    {
      system: "base",
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "mid-convo directive" },
        { role: "assistant", content: "ok" },
      ],
    },
    "claude-opus-4-8",
  );
  const sys = body.system as Array<{ type: string; text: string }>;
  assert.ok(sys.some((b) => b.text === "base"));
  assert.ok(sys.some((b) => b.text === "mid-convo directive"));
  // The system turn is gone from messages[].
  const roles = (body.messages as Array<{ role: string }>).map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant"]);
});

// --- max-tokens ------------------------------------------------------------

test("max-tokens: clamps to the ceiling", () => {
  const body = clampMaxTokens({ max_tokens: 200000 }, 128000);
  assert.equal(body.max_tokens, 128000);
});

test("max-tokens: no ceiling -> unchanged", () => {
  const body = clampMaxTokens({ max_tokens: 200000 }, null);
  assert.equal(body.max_tokens, 200000);
});

test("max-tokens: shrinks budget when clamp would breach budget < max invariant", () => {
  const body = clampMaxTokens(
    {
      max_tokens: 200000,
      thinking: { type: "enabled", budget_tokens: 150000 },
    },
    100000,
  );
  assert.equal(body.max_tokens, 100000);
  // budget shrunk below max so the request stays valid.
  const budget = (body.thinking as { budget_tokens: number }).budget_tokens;
  assert.ok(budget < 100000, `expected budget < 100000, got ${budget}`);
});

// --- composed stack --------------------------------------------------------

test("stack: order is thinking-signature, max-tokens, prefill, sanitize-request, thinking-mode, thinking-config", () => {
  const names = defaultAnthropicRequestHooks().map((h) => h.name);
  assert.deepEqual(names, [
    "anthropic:thinking-signature",
    "anthropic:max-tokens",
    "anthropic:prefill",
    "anthropic:sanitize-request",
    "anthropic:thinking-mode",
    "anthropic:thinking-config",
  ]);
});

test("stack: prefill appends a trailing user turn on a prefill-less Claude model", () => {
  const hooks = defaultAnthropicRequestHooks();
  const prefill = hooks.find((h) => h.name === "anthropic:prefill")!;
  const body: Record<string, unknown> = {
    model: "up-1",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "partial" },
    ],
  };
  prefill.apply(body, ctx({ upstreamModel: "claude-opus-4-8" }));
  const msgs = body.messages as Array<{ role: string }>;
  assert.equal(msgs[msgs.length - 1].role, "user");
});

test("stack: max-tokens hook clamps via ctx.maxOutputTokens", () => {
  const hooks = defaultAnthropicRequestHooks();
  const clamp = hooks.find((h) => h.name === "anthropic:max-tokens")!;
  const body = clamp.apply(
    { max_tokens: 999999 },
    ctx({ maxOutputTokens: 64000 }),
  );
  assert.equal(body.max_tokens, 64000);
});

// --- fires on the CONVERTED (chat->messages) body --------------------------

test("hooks run on a chat->messages converted body (thinking reconcile, Opus 4.6)", () => {
  // Simulate the engine: convert chat -> messages, THEN run the adapter hooks.
  // Opus 4.6 still accepts enabled+budget_tokens, so budget reconciliation fires.
  const converted = chatRequestToMessages({
    model: "gpt-ish",
    max_tokens: 4000,
    messages: [{ role: "user", content: "hi" }],
  });
  (converted as Record<string, unknown>).thinking = {
    type: "enabled",
    budget_tokens: 8000,
  };
  let body: Record<string, unknown> = converted;
  for (const h of defaultAnthropicRequestHooks())
    body = h.apply(
      body,
      ctx({
        upstreamModel: "claude-opus-4-6-20250715",
        maxOutputTokens: 128000,
      }),
    );
  // max_tokens raised above budget so Anthropic won't 400.
  assert.ok(
    (body.max_tokens as number) > 8000,
    `expected max_tokens > 8000, got ${body.max_tokens}`,
  );
});

test("hooks convert enabled to adaptive on Opus 4.8", () => {
  const converted = chatRequestToMessages({
    model: "gpt-ish",
    max_tokens: 4000,
    messages: [{ role: "user", content: "hi" }],
  });
  (converted as Record<string, unknown>).thinking = {
    type: "enabled",
    budget_tokens: 8000,
  };
  let body: Record<string, unknown> = converted;
  for (const h of defaultAnthropicRequestHooks())
    body = h.apply(
      body,
      ctx({ upstreamModel: "claude-opus-4-8", maxOutputTokens: 128000 }),
    );
  const thinking = body.thinking as { type?: string; budget_tokens?: number };
  assert.equal(thinking.type, "adaptive");
  assert.equal(thinking.budget_tokens, undefined);
});

// --- thinking display -------------------------------------------------------

test("thinking-mode injects display:summarized on models that default to omitted", () => {
  const models = [
    "claude-opus-4-8",
    "claude-opus-4-7-20250715",
    "claude-sonnet-5-20250715",
    "claude-fable-5-20250715",
    "claude-mythos-5-20250715",
    "claude-mythos-preview-20250715",
  ];
  for (const m of models) {
    let body: Record<string, unknown> = {
      model: m,
      max_tokens: 4000,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive" },
    };
    for (const h of defaultAnthropicRequestHooks())
      body = h.apply(body, ctx({ upstreamModel: m }));
    const thinking = body.thinking as { display?: string };
    assert.equal(
      thinking.display,
      "summarized",
      `expected display:summarized on ${m}`,
    );
  }
});

test("thinking-mode does NOT inject display on Opus 4.6 / Sonnet 4.6", () => {
  for (const m of ["claude-opus-4-6-20250715", "claude-sonnet-4-6-20250715"]) {
    let body: Record<string, unknown> = {
      model: m,
      max_tokens: 4000,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive" },
    };
    for (const h of defaultAnthropicRequestHooks())
      body = h.apply(body, ctx({ upstreamModel: m }));
    const thinking = body.thinking as { display?: string };
    assert.equal(thinking.display, undefined, `expected no display on ${m}`);
  }
});

test("thinking-mode preserves explicit display:omitted from client", () => {
  let body: Record<string, unknown> = {
    model: "claude-opus-4-8",
    max_tokens: 4000,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "adaptive", display: "omitted" },
  };
  for (const h of defaultAnthropicRequestHooks())
    body = h.apply(body, ctx({ upstreamModel: "claude-opus-4-8" }));
  const thinking = body.thinking as { display?: string };
  assert.equal(thinking.display, "omitted");
});

// --- hosted tools pass through untouched -----------------------------------

test("hosted Anthropic tools survive the request hooks unchanged", () => {
  const tools = [
    { type: "web_search_20250305", name: "web_search" },
    { type: "computer_20241022", name: "computer", display_width_px: 1024 },
    { name: "get_weather", input_schema: { type: "object", properties: {} } },
  ];
  let body: Record<string, unknown> = {
    model: "up-1",
    max_tokens: 1000,
    messages: [{ role: "user", content: "search" }],
    tools: structuredClone(tools),
  };
  for (const h of defaultAnthropicRequestHooks())
    body = h.apply(body, ctx({ upstreamModel: "claude-opus-4-8" }));
  assert.deepEqual(body.tools, tools);
});
