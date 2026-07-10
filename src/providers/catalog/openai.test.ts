// OpenAI adapter: the model-aware Responses-API preference heuristic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { prefersResponses } from "./openai";

test("prefersResponses matches GPT-5+/codex/image-2+/o3+ families", () => {
  for (const m of [
    "gpt-5",
    "gpt-5.5",
    "gpt-5.4-mini",
    "gpt-6-preview",
    "gpt-5-codex",
    "codex-mini",
    "gpt-image-2",
    "o3",
    "o4-mini",
  ]) {
    assert.equal(prefersResponses(m), true, `${m} should prefer responses`);
  }
});

test("prefersResponses is false for older/dual-endpoint models", () => {
  for (const m of [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1",
    "o1",
    "o1-pro",
    "gpt-3.5-turbo",
    "gpt-image-1",
    "text-embedding-3-large",
  ]) {
    assert.equal(prefersResponses(m), false, `${m} should stay on chat`);
  }
});

test("prefersResponses is case-insensitive", () => {
  assert.equal(prefersResponses("GPT-5.5"), true);
  assert.equal(prefersResponses("GPT-Codex"), true);
});
