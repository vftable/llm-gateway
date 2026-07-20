// resolveProviderTransforms() tests — verifies the resolved-transforms preview
// (GET /providers/:id/transforms/resolved) composes the SAME layers, in the
// SAME order, that engine.ts's buildRoute()/buildChain() actually apply at
// request time: builtin defaults -> family defaults -> adapter transforms ->
// the model's own overrides. Pure/DB-agnostic (Provider + optional
// ownTransforms in, no DB) — see the module's own header comment for the full
// design rationale.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProviderTransforms } from "./resolved-transforms";
import type { Provider } from "../../types";

const provider = (over: Partial<Provider> = {}): Provider =>
  ({
    id: "p",
    catalogId: "anthropic",
    format: "anthropic",
    nativeConversion: false,
    endpoints: [],
    basePath: "",
    baseUrl: "https://api.anthropic.com",
    ...over,
  }) as unknown as Provider;

test("Anthropic-native provider: builtin hooks + thinking + family defaults, no model layer", () => {
  const r = resolveProviderTransforms(provider());
  assert.equal(r.nativeFormat, "anthropic");
  assert.equal(r.nativeWireKind, "messages");

  // Builtin Anthropic hooks land first, in stack order.
  const builtinReq = r.request.filter((s) => s.source === "builtin");
  assert.deepEqual(
    builtinReq.map((s) => s.name),
    [
      "anthropic:thinking-signature",
      "anthropic:max-tokens",
      "anthropic:prefill",
      "anthropic:sanitize-request",
      "anthropic:thinking-mode",
      "anthropic:thinking-config",
      "anthropic:cache-control-limit",
    ],
  );

  // Family defaults (anthropic-cache request, sanitize-tool-args response)
  // appear, fully described (library-backed), and nothing is overridden
  // (no model was given).
  const family = [...r.request, ...r.response].filter(
    (s) => s.source === "family",
  );
  assert.ok(family.some((s) => s.name === "family:anthropic-cache"));
  assert.ok(family.some((s) => s.name === "family:sanitize-tool-args"));
  for (const s of family) {
    assert.ok(s.label, `${s.name} missing label`);
  }
  assert.deepEqual(r.overridden, []);

  // No model layer at all when ownTransforms wasn't given.
  assert.equal(r.request.filter((s) => s.source === "model").length, 0);
});

test("builtin stages carry label/blurb/group display metadata", () => {
  const r = resolveProviderTransforms(provider());
  const builtinReq = r.request.filter((s) => s.source === "builtin");

  // Every one of the four Anthropic request hooks declares label+blurb (see
  // formats/anthropic/hooks/stack.ts) and shares the same group, so the UI
  // can collapse them into one row.
  for (const s of builtinReq) {
    assert.ok(s.label, `${s.name} missing label`);
    assert.ok(s.blurb, `${s.name} missing blurb`);
  }
  const groups = new Set(builtinReq.map((s) => s.group));
  assert.deepEqual([...groups], ["anthropic-hooks"]);

  // The response-side <thinking> extraction default also carries metadata.
  const thinkingResp = r.response.find((s) => s.name === "thinking:messages");
  assert.ok(thinkingResp);
  assert.ok(thinkingResp!.label);
  assert.ok(thinkingResp!.blurb);
});

test("OpenAI-native provider: OpenAI reasoning hooks, no Anthropic hooks, has openai-cache family default", () => {
  const r = resolveProviderTransforms(
    provider({ catalogId: "openai", format: "openai" }),
  );
  assert.equal(r.nativeFormat, "openai");
  assert.equal(r.nativeWireKind, "chat");
  const builtinReq = r.request.filter((s) => s.source === "builtin");
  assert.equal(builtinReq.length, 1);
  assert.equal(builtinReq[0].name, "openai:reasoning");
  assert.equal(
    r.request.filter((s) => s.name.startsWith("anthropic:")).length,
    0,
  );
  const familyStages = [...r.request, ...r.response].filter(
    (s) => s.source === "family",
  );
  assert.equal(familyStages.length, 1);
  assert.equal(familyStages[0].name, "family:openai-cache");
});

test("a model's own transform overrides the matching family default (same id+phase)", () => {
  const r = resolveProviderTransforms(provider(), [
    { id: "anthropic-cache", phase: "request", params: { ttl: "1h" } },
  ]);
  const requestFamilyAndModel = r.request.filter(
    (s) => s.source === "family" || s.source === "model",
  );
  // Only ONE anthropic-cache stage survives in the live list — the model's.
  const cacheStages = requestFamilyAndModel.filter((s) =>
    s.name.endsWith(":anthropic-cache"),
  );
  assert.equal(cacheStages.length, 1);
  assert.equal(cacheStages[0].source, "model");
  assert.deepEqual(cacheStages[0].params, { ttl: "1h" });

  // sanitize-tool-args (untouched) still shows as a family default.
  assert.ok(
    r.response.some(
      (s) => s.source === "family" && s.name === "family:sanitize-tool-args",
    ),
  );

  // The overridden family default is surfaced separately, flagged.
  assert.equal(r.overridden.length, 1);
  assert.equal(r.overridden[0].name, "family:anthropic-cache");
  assert.equal(r.overridden[0].overridden, true);
});

test("a model's own transform with no family counterpart is simply appended", () => {
  const r = resolveProviderTransforms(provider(), [
    { id: "system-prepend", phase: "request", params: { text: "hi" } },
  ]);
  assert.ok(
    r.request.some(
      (s) => s.source === "model" && s.name === "model:system-prepend",
    ),
  );
  assert.deepEqual(r.overridden, []);
});

test("family defaults run BEFORE the adapter's own stack (claude-code)", () => {
  // claude-code's adapter appends its no-op hook stack to
  // requestTransforms(). Its family base is the same ANTHROPIC_DEFAULT_TRANSFORMS
  // as plain anthropic (anthropic-cache request / sanitize-tool-args response).
  // Prompt-caching breakpoints must already be in place before the subscription
  // stack's stages inspect the body, so family:anthropic-cache must precede
  // every claude-code:* stage in the resolved request list.
  const r = resolveProviderTransforms(provider({ catalogId: "claude-code" }));
  const familyIdx = r.request.findIndex(
    (s) => s.source === "family" && s.name === "family:anthropic-cache",
  );
  const subscriptionIdx = r.request.findIndex((s) =>
    s.name.startsWith("claude-code:"),
  );
  assert.notEqual(familyIdx, -1, "family:anthropic-cache not found");
  assert.notEqual(subscriptionIdx, -1, "claude-code stage not found");
  assert.ok(
    familyIdx < subscriptionIdx,
    `expected family default (${familyIdx}) before adapter stage (${subscriptionIdx})`,
  );
});

test("stream bucket never contains family/model stages (no ModelTransformConfig stream phase exists)", () => {
  const r = resolveProviderTransforms(provider(), [
    { id: "anthropic-cache", phase: "request", params: {} },
  ]);
  assert.ok(
    r.stream.every((s) => s.source === "builtin" || s.source === "adapter"),
  );
});
