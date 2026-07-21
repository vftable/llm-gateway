import { test } from "node:test";
import assert from "node:assert/strict";
import { isGlm52Plus, isGlmModel, modelClassOf } from "./model-version";

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
