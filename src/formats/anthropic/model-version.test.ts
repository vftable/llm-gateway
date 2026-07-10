// Shared Claude version-check boundary tests.
//
// isModelPost45 is the ONE regex that decides "newer than 4.5". It's correctness-
// critical: prefill.ts (modelNeedsPrefillFix) uses it to decide whether a trailing
// assistant turn needs a synthetic user "continue" turn — matching a 4.5 model by
// mistake would corrupt a valid request, and missing a 4.6 model would let a 400
// through. These pin the boundary in both directions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isModelPost45 } from "./model-version";
import { modelNeedsPrefillFix } from "./prefill";

test("post-4.5 models match (4.6+, 5+, fable/mythos)", () => {
  for (const m of [
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-8",
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-opus-5-20260101",
    "claude-haiku-9",
    "claude-fable-5",
    "claude-mythos",
    "Claude-Opus-4-8", // case-insensitive
  ]) {
    assert.equal(isModelPost45(m), true, `${m} should be post-4.5`);
  }
});

test("4.5 and older Claude models do NOT match", () => {
  for (const m of [
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-5-20250929",
    "claude-haiku-4-5",
    "claude-3-5-sonnet-20241022",
    "claude-3-opus",
    "claude-opus-4-1",
  ]) {
    assert.equal(isModelPost45(m), false, `${m} should be <= 4.5`);
  }
});

test("non-Claude and malformed inputs never match", () => {
  for (const m of [
    "gpt-5.5",
    "gemini-2.5-pro",
    "ollama/llama3",
    "",
    42,
    null,
  ]) {
    assert.equal(isModelPost45(m as unknown), false);
  }
});

test("modelNeedsPrefillFix delegates to the shared check (same boundary)", () => {
  // The consolidation: prefill's predicate IS isModelPost45.
  assert.equal(modelNeedsPrefillFix("claude-opus-4-8"), true);
  assert.equal(modelNeedsPrefillFix("claude-opus-4-5-20251101"), false);
  assert.equal(modelNeedsPrefillFix(""), false);
});
