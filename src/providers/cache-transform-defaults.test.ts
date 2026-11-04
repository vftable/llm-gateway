// Which providers get the `openai-cache` family default.
//
// That stage sets `prompt_cache_retention` + `prompt_cache_key`, which are
// OpenAI-platform fields. Gemini's compatibility surface is a strict
// proto-backed parser that REJECTS unknown fields — verified live, a request
// carrying them returns 400 INVALID_ARGUMENT ('Unknown name
// "prompt_cache_retention": Cannot find field'), while the same body without
// them gets past validation to the auth check. So this was failing every
// request, not being harmlessly ignored. NIM likewise doesn't implement them.
//
// Family defaults are resolved LIVE from the catalog by familyDefaultTransforms
// (engine.ts builds ChainEntry.familyTransforms from it per request) and are
// never copied into a stored provider row, so removing the catalog default also
// fixes providers that were created earlier — that's what the last test pins.

import { test } from "node:test";
import assert from "node:assert/strict";
import { familyDefaultTransforms } from "./index";
import { buildModelTransforms } from "../formats/transforms/apply";
import { applyBodyTransforms, type Json } from "../formats/pipeline";
import { WireKind, type Provider } from "../types";

const providerRow = (catalogId: string, over: Partial<Provider> = {}) =>
  ({ id: catalogId, catalogId, name: catalogId, ...over }) as Provider;

// Run a provider's family-default request stack over a plain chat body.
function bodyAfterFamilyDefaults(provider: Provider): Json {
  const stages = buildModelTransforms(
    familyDefaultTransforms(provider),
    "request",
  );
  return applyBodyTransforms(
    stages as never,
    { model: "m", messages: [{ role: "user", content: "hi" }] },
    {
      provider,
      clientFmt: WireKind.Chat,
      providerFmt: WireKind.Chat,
      upstreamModel: "m",
    } as never,
  ) as Json;
}

for (const id of ["google-gemini", "nvidia-nim", "mistral"]) {
  test(`${id} does not send prompt_cache_* (the upstream rejects them)`, () => {
    assert.deepEqual(familyDefaultTransforms(providerRow(id)), []);
    const body = bodyAfterFamilyDefaults(providerRow(id));
    assert.equal(body.prompt_cache_retention, undefined);
    assert.equal(body.prompt_cache_key, undefined);
  });
}

for (const id of ["openai", "deepseek", "moonshot", "dashscope-coding"]) {
  test(`${id} still gets the cache default (regression guard)`, () => {
    // Removing the default from two providers must not quietly drop it
    // everywhere — this is the other half of the change.
    const ids = familyDefaultTransforms(providerRow(id)).map((t) => t.id);
    assert.ok(
      ids.includes("openai-cache"),
      `${id} lost openai-cache; got ${JSON.stringify(ids)}`,
    );
    const body = bodyAfterFamilyDefaults(providerRow(id));
    assert.equal(body.prompt_cache_retention, "24h");
    assert.ok(typeof body.prompt_cache_key === "string");
  });
}

test("the fix reaches a provider row saved BEFORE the default was removed", () => {
  // Family defaults are resolved from the catalog per request, never persisted,
  // so an existing row carries nothing that could reintroduce the field.
  const legacy = providerRow("google-gemini", {
    transforms: [{ id: "openai-cache", phase: "request", params: {} }],
  } as Partial<Provider>);
  assert.deepEqual(familyDefaultTransforms(legacy), []);
  assert.equal(
    bodyAfterFamilyDefaults(legacy).prompt_cache_retention,
    undefined,
  );
});
