import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isDeepSeekReasoner,
  isGlm52Plus,
  isGlmModel,
  modelClassOf,
} from "./model-version";

test("modelClassOf groups normal and premium Claude quota classes", () => {
  for (const model of [
    "claude-sonnet-5",
    "claude-opus-4-8",
    "claude-haiku-4-5",
  ])
    assert.equal(modelClassOf(model), "base", model);
  for (const model of [
    "claude-fable-5",
    "claude-mythos-5",
    "claude-mythos-preview",
  ])
    assert.equal(modelClassOf(model), "fable", model);
  for (const model of ["gpt-5.6", "glm-5.2", "custom-claude-ish"])
    assert.equal(modelClassOf(model), null, model);
});

test("GLM model predicate recognizes versioned GLM ids", () => {
  assert.equal(isGlmModel("glm-4.7"), true);
  assert.equal(isGlmModel("GLM-5.2"), true);
  assert.equal(isGlmModel("glm-5.2-plus"), true);
  assert.equal(isGlmModel("glm-5.2_20260101"), true);
  assert.equal(isGlmModel("my-glm-5.2"), false);
  assert.equal(isGlmModel("gpt-5.2"), false);
});

test("GLM 5.2+ predicate respects major/minor versions and suffixes", () => {
  assert.equal(isGlm52Plus("glm-4.7"), false);
  assert.equal(isGlm52Plus("glm-5"), false);
  assert.equal(isGlm52Plus("glm-5.1"), false);
  assert.equal(isGlm52Plus("glm-5.2"), true);
  assert.equal(isGlm52Plus("glm-5.2-plus"), true);
  assert.equal(isGlm52Plus("glm-5.3"), true);
  assert.equal(isGlm52Plus("glm-6"), true);
  assert.equal(isGlm52Plus("openrouter/glm-5.2"), false);
});

// --- DeepSeek reasoner -------------------------------------------------------

test("isDeepSeekReasoner matches DeepSeek models that support thinking toggle", () => {
  // Reasoner / R1 family
  assert.equal(isDeepSeekReasoner("deepseek-reasoner"), true);
  assert.equal(isDeepSeekReasoner("deepseek-r1"), true);
  assert.equal(isDeepSeekReasoner("DEEPSEEK-REASONER"), true);
  assert.equal(isDeepSeekReasoner("DeepSeek-R1"), true);
  // V4 family (newer chat models with thinking support)
  assert.equal(isDeepSeekReasoner("deepseek-v4"), true);
  assert.equal(isDeepSeekReasoner("deepseek-v4-something"), true);
  assert.equal(isDeepSeekReasoner("DEEPSEEK-V4"), true);
  // Non-reasoner chat models — no thinking support
  assert.equal(isDeepSeekReasoner("deepseek-chat"), false);
  assert.equal(isDeepSeekReasoner("deepseek-v3"), false);
  assert.equal(isDeepSeekReasoner("gpt-5"), false);
  assert.equal(isDeepSeekReasoner(""), false);
  assert.equal(isDeepSeekReasoner(null), false);
  assert.equal(isDeepSeekReasoner(undefined), false);
  assert.equal(isDeepSeekReasoner(42), false);
});
