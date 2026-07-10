// Transform library tests: each built-in behaves, and buildModelTransforms
// resolves config into named, phase-filtered, crash-safe pipeline stages.

import { test } from "node:test";
import assert from "node:assert/strict";
import { getTransformDef, listTransformDefs, buildModelTransforms } from ".";
import type { TransformCtx } from "../pipeline";

const ctx = {} as TransformCtx; // transforms here don't read ctx

function apply(
  id: string,
  params: Record<string, unknown>,
  body: Record<string, unknown>,
) {
  return getTransformDef(id)!.build(params)(body);
}

test("library lists the built-in transforms with param specs", () => {
  const ids = listTransformDefs().map((d) => d.id);
  for (const id of [
    "set-field",
    "set-default",
    "delete-field",
    "rename-field",
    "clamp-number",
  ])
    assert.ok(ids.includes(id), `missing ${id}`);
  for (const d of listTransformDefs()) {
    assert.ok(d.label && d.blurb, `${d.id} missing metadata`);
    assert.ok(d.phases.length > 0, `${d.id} has no phases`);
    assert.ok(Array.isArray(d.params));
  }
});

test("set-field sets a value, JSON-coercing when possible", () => {
  assert.deepEqual(
    apply("set-field", { path: "temperature", value: "0.7" }, {}),
    {
      temperature: 0.7,
    },
  );
  assert.deepEqual(apply("set-field", { path: "stream", value: "true" }, {}), {
    stream: true,
  });
  // dotted path creates intermediates
  assert.deepEqual(apply("set-field", { path: "a.b", value: "x" }, {}), {
    a: { b: "x" },
  });
});

test("set-default only fills when absent", () => {
  assert.deepEqual(
    apply(
      "set-default",
      { path: "max_tokens", value: "1000" },
      { max_tokens: 50 },
    ),
    { max_tokens: 50 },
  );
  assert.deepEqual(
    apply("set-default", { path: "max_tokens", value: "1000" }, {}),
    {
      max_tokens: 1000,
    },
  );
});

test("delete-field removes the field", () => {
  assert.deepEqual(
    apply("delete-field", { path: "logprobs" }, { logprobs: true, model: "x" }),
    { model: "x" },
  );
});

test("rename-field moves a value", () => {
  assert.deepEqual(apply("rename-field", { from: "a", to: "b" }, { a: 1 }), {
    b: 1,
  });
  // no-op when source missing
  assert.deepEqual(apply("rename-field", { from: "a", to: "b" }, { c: 2 }), {
    c: 2,
  });
});

test("clamp-number caps only when over the max", () => {
  assert.deepEqual(
    apply(
      "clamp-number",
      { path: "max_tokens", max: 8192 },
      { max_tokens: 100000 },
    ),
    {
      max_tokens: 8192,
    },
  );
  assert.deepEqual(
    apply(
      "clamp-number",
      { path: "max_tokens", max: 8192 },
      { max_tokens: 500 },
    ),
    {
      max_tokens: 500,
    },
  );
});

test("buildModelTransforms filters by phase and names stages", () => {
  const cfg = [
    {
      id: "clamp-number",
      phase: "request" as const,
      params: { path: "max_tokens", max: 8 },
    },
    {
      id: "delete-field",
      phase: "request" as const,
      params: { path: "logprobs" },
    },
    {
      id: "rename-field",
      phase: "response" as const,
      params: { from: "a", to: "b" },
    },
  ];
  const reqStages = buildModelTransforms(cfg, "request");
  assert.deepEqual(
    reqStages.map((s) => s.name),
    ["model:clamp-number", "model:delete-field"],
  );
  const respStages = buildModelTransforms(cfg, "response");
  assert.deepEqual(
    respStages.map((s) => s.name),
    ["model:rename-field"],
  );

  // request stages actually apply
  let body: Record<string, unknown> = { max_tokens: 999, logprobs: true };
  for (const s of reqStages) body = s.apply(body, ctx);
  assert.deepEqual(body, { max_tokens: 8 });
});

test("unknown transform ids are skipped, not thrown", () => {
  const stages = buildModelTransforms(
    [{ id: "does-not-exist", phase: "request", params: {} }],
    "request",
  );
  assert.equal(stages.length, 0);
});

// --- opt-in extras ---------------------------------------------------------

test("anthropic-cache marks the last system block, last tool, last message", () => {
  const body = apply(
    "anthropic-cache",
    { ttl: "1h" },
    {
      system: [{ type: "text", text: "sys" }],
      tools: [{ name: "a" }, { name: "b" }],
      messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
    },
  );
  const sys = body.system as Array<Record<string, unknown>>;
  assert.deepEqual(sys[0].cache_control, { type: "ephemeral", ttl: "1h" });
  const tools = body.tools as Array<Record<string, unknown>>;
  assert.equal(
    (tools[0] as { cache_control?: unknown }).cache_control,
    undefined,
  );
  assert.deepEqual(tools[1].cache_control, { type: "ephemeral", ttl: "1h" });
  const msg = (
    body.messages as Array<{ content: Array<Record<string, unknown>> }>
  )[0];
  assert.deepEqual(msg.content[0].cache_control, {
    type: "ephemeral",
    ttl: "1h",
  });
});

test("anthropic-cache defaults ttl to 5m (no ttl field emitted)", () => {
  const body = apply("anthropic-cache", {}, { system: "hi" });
  const sys = body.system as Array<Record<string, unknown>>;
  assert.deepEqual(sys[0].cache_control, { type: "ephemeral" });
});

test("anthropic-cache skips thinking blocks when marking the last message", () => {
  const body = apply(
    "anthropic-cache",
    {},
    {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "ans" },
            { type: "thinking", thinking: "..." },
          ],
        },
      ],
    },
  );
  const content = (
    body.messages as Array<{ content: Array<Record<string, unknown>> }>
  )[0].content;
  // thinking block (last) is NOT marked; the text block is.
  assert.equal(
    (content[1] as { cache_control?: unknown }).cache_control,
    undefined,
  );
  assert.deepEqual(content[0].cache_control, { type: "ephemeral" });
});

test("anthropic-cache is a no-op on an OpenAI Chat-shaped body (role:tool)", () => {
  // anthropic-cache is now also an unconditional Anthropic-FAMILY default (see
  // ANTHROPIC_DEFAULT_TRANSFORMS), applied regardless of the resolved hop
  // format — so it needs its own shape guard for the case an operator pins a
  // provider endpoint away from Messages. `role:"tool"` never appears in a
  // genuine Anthropic Messages body (Anthropic uses tool_result CONTENT
  // BLOCKS instead), so this is an unambiguous OpenAI signal.
  const body = apply(
    "anthropic-cache",
    {},
    {
      system: "sys",
      messages: [
        { role: "assistant", tool_calls: [{ id: "1" }] },
        { role: "tool", tool_call_id: "1", content: "42" },
      ],
    },
  );
  // system was left as the original STRING — proof the transform didn't even
  // begin its normal system -> block-array rewrite, let alone mark anything.
  assert.equal(body.system, "sys");
});

test("anthropic-cache is a no-op on an OpenAI Chat-shaped body (function tools)", () => {
  const body = apply(
    "anthropic-cache",
    {},
    {
      tools: [{ type: "function", function: { name: "f", parameters: {} } }],
    },
  );
  const tools = body.tools as Array<Record<string, unknown>>;
  assert.equal(
    (tools[0] as { cache_control?: unknown }).cache_control,
    undefined,
  );
});

test("system-prepend prepends to Anthropic system string", () => {
  const body = apply("system-prepend", { text: "PRE" }, { system: "base" });
  assert.equal(body.system, "PRE\nbase");
});

test("system-prepend unshifts a chat system message when none exists", () => {
  const body = apply(
    "system-prepend",
    { text: "PRE" },
    { messages: [{ role: "user", content: "hi" }] },
  );
  const msgs = body.messages as Array<{ role: string; content: string }>;
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[0].content, "PRE");
});

test("sanitize-tool-args clamps Read.limit in an Anthropic tool_use", () => {
  const body = apply(
    "sanitize-tool-args",
    {},
    {
      content: [
        {
          type: "tool_use",
          name: "Read",
          input: { limit: "5000", offset: "-3" },
        },
      ],
    },
  );
  const tu = (body.content as Array<{ input: Record<string, unknown> }>)[0]
    .input;
  assert.equal(tu.limit, 2000);
  assert.equal(tu.offset, 0);
});

test("sanitize-tool-args fixes Read args inside a chat tool_call arguments string", () => {
  const body = apply(
    "sanitize-tool-args",
    {},
    {
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: { name: "Read", arguments: '{"limit":"9999"}' },
              },
            ],
          },
        },
      ],
    },
  );
  const args = JSON.parse(
    (
      body.choices as Array<{
        message: { tool_calls: Array<{ function: { arguments: string } }> };
      }>
    )[0].message.tool_calls[0].function.arguments,
  );
  assert.equal(args.limit, 2000);
});
