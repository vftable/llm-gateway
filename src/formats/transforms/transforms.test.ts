// Transform library tests: each built-in behaves, and buildModelTransforms
// resolves config into named, phase-filtered, crash-safe pipeline stages.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getTransformDef,
  listTransformDefs,
  buildModelTransforms,
} from ".";
import type { TransformCtx } from "../pipeline";

const ctx = {} as TransformCtx; // transforms here don't read ctx

function apply(id: string, params: Record<string, unknown>, body: Record<string, unknown>) {
  return getTransformDef(id)!.build(params)(body);
}

test("library lists the built-in transforms with param specs", () => {
  const ids = listTransformDefs().map((d) => d.id);
  for (const id of ["set-field", "set-default", "delete-field", "rename-field", "clamp-number"])
    assert.ok(ids.includes(id), `missing ${id}`);
  for (const d of listTransformDefs()) {
    assert.ok(d.label && d.blurb, `${d.id} missing metadata`);
    assert.ok(d.phases.length > 0, `${d.id} has no phases`);
    assert.ok(Array.isArray(d.params));
  }
});

test("set-field sets a value, JSON-coercing when possible", () => {
  assert.deepEqual(apply("set-field", { path: "temperature", value: "0.7" }, {}), {
    temperature: 0.7,
  });
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
    apply("set-default", { path: "max_tokens", value: "1000" }, { max_tokens: 50 }),
    { max_tokens: 50 },
  );
  assert.deepEqual(apply("set-default", { path: "max_tokens", value: "1000" }, {}), {
    max_tokens: 1000,
  });
});

test("delete-field removes the field", () => {
  assert.deepEqual(
    apply("delete-field", { path: "logprobs" }, { logprobs: true, model: "x" }),
    { model: "x" },
  );
});

test("rename-field moves a value", () => {
  assert.deepEqual(
    apply("rename-field", { from: "a", to: "b" }, { a: 1 }),
    { b: 1 },
  );
  // no-op when source missing
  assert.deepEqual(apply("rename-field", { from: "a", to: "b" }, { c: 2 }), {
    c: 2,
  });
});

test("clamp-number caps only when over the max", () => {
  assert.deepEqual(apply("clamp-number", { path: "max_tokens", max: 8192 }, { max_tokens: 100000 }), {
    max_tokens: 8192,
  });
  assert.deepEqual(apply("clamp-number", { path: "max_tokens", max: 8192 }, { max_tokens: 500 }), {
    max_tokens: 500,
  });
});

test("buildModelTransforms filters by phase and names stages", () => {
  const cfg = [
    { id: "clamp-number", phase: "request" as const, params: { path: "max_tokens", max: 8 } },
    { id: "delete-field", phase: "request" as const, params: { path: "logprobs" } },
    { id: "rename-field", phase: "response" as const, params: { from: "a", to: "b" } },
  ];
  const reqStages = buildModelTransforms(cfg, "request");
  assert.deepEqual(reqStages.map((s) => s.name), [
    "model:clamp-number",
    "model:delete-field",
  ]);
  const respStages = buildModelTransforms(cfg, "response");
  assert.deepEqual(respStages.map((s) => s.name), ["model:rename-field"]);

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
