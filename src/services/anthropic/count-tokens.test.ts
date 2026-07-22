import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contextWindowLimit,
  countTokensUrl,
  buildCountTokensBody,
  SONNET_46_BASE_WINDOW,
} from "./count-tokens";

test("contextWindowLimit gates ONLY Claude Code Sonnet 4.6 on the messages route", () => {
  const url = "https://api.anthropic.com/v1/messages?beta=true";
  // Gated.
  assert.equal(
    contextWindowLimit("claude-code", "claude-sonnet-4-6", url),
    SONNET_46_BASE_WINDOW,
  );
  // Not Sonnet 4.6 — no gate (Opus 4.6 1M, Sonnet 4.5, Opus, Haiku, etc.).
  assert.equal(contextWindowLimit("claude-code", "claude-opus-4-6", url), null);
  assert.equal(
    contextWindowLimit("claude-code", "claude-sonnet-4-5", url),
    null,
  );
  assert.equal(contextWindowLimit("claude-code", "claude-sonnet-5", url), null);
  // Not Claude Code — no gate.
  assert.equal(contextWindowLimit("anthropic", "claude-sonnet-4-6", url), null);
  assert.equal(contextWindowLimit(null, "claude-sonnet-4-6", url), null);
  // Not the messages route (cross-format hop to /chat/completions) — no gate.
  assert.equal(
    contextWindowLimit(
      "claude-code",
      "claude-sonnet-4-6",
      "https://api.anthropic.com/v1/chat/completions",
    ),
    null,
  );
});

test("countTokensUrl inserts /count_tokens after /messages, preserving the query", () => {
  assert.equal(
    countTokensUrl("https://api.anthropic.com/v1/messages"),
    "https://api.anthropic.com/v1/messages/count_tokens",
  );
  assert.equal(
    countTokensUrl("https://api.anthropic.com/v1/messages?beta=true"),
    "https://api.anthropic.com/v1/messages/count_tokens?beta=true",
  );
  // Non-messages path is returned unchanged.
  assert.equal(
    countTokensUrl("https://api.anthropic.com/v1/chat/completions"),
    "https://api.anthropic.com/v1/chat/completions",
  );
});

test("buildCountTokensBody keeps only the fields count_tokens accepts", () => {
  const body = buildCountTokensBody({
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
    system: "be nice",
    tools: [{ name: "t" }],
    thinking: { type: "enabled" },
    context_management: { foo: 1 },
    output_config: { bar: 2 },
    max_tokens: 100,
    stream: true,
    metadata: { user_id: "x" },
    temperature: 0.5,
  });
  assert.deepEqual(Object.keys(body).sort(), [
    "context_management",
    "messages",
    "model",
    "output_config",
    "system",
    "thinking",
    "tools",
  ]);
  assert.equal("max_tokens" in body, false);
  assert.equal("stream" in body, false);
  assert.equal("metadata" in body, false);
  assert.equal("temperature" in body, false);
});
