import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isClaudeCodeUsageCreditsError,
  LONG_CONTEXT_USAGE_CREDITS_MESSAGE,
} from "./usage-credits";

const body = JSON.stringify({
  type: "error",
  error: {
    type: "rate_limit_error",
    message: LONG_CONTEXT_USAGE_CREDITS_MESSAGE,
  },
  request_id: "req_test",
});

function matches(
  overrides: Partial<Parameters<typeof isClaudeCodeUsageCreditsError>[0]> = {},
): boolean {
  return isClaudeCodeUsageCreditsError({
    status: 429,
    catalogId: "claude-code",
    upstreamModel: "claude-sonnet-4-6",
    body,
    ...overrides,
  });
}

test("matches the exact Claude Code Sonnet 4.6 long-context credits error", () => {
  assert.equal(matches(), true);
});

test("rejects other statuses and providers", () => {
  assert.equal(matches({ status: 400 }), false);
  assert.equal(matches({ catalogId: "anthropic" }), false);
});

test("is no longer model-gated — any Claude Code model with this 429 matches", () => {
  // The predicate used to require Sonnet 4.6; that gate was removed, so the
  // long-context credits 429 is now recognised for any Claude Code model.
  assert.equal(matches({ upstreamModel: "claude-opus-4-6" }), true);
  assert.equal(matches({ upstreamModel: "claude-sonnet-4-5" }), true);
});

test("rejects a non-rate-limit error type even with the credits message", () => {
  assert.equal(
    matches({
      body: JSON.stringify({
        error: {
          type: "invalid_request_error",
          message: LONG_CONTEXT_USAGE_CREDITS_MESSAGE,
        },
      }),
    }),
    false,
  );
});

test("matches by substring — trailing wording and the 'Extra usage' variant", () => {
  // Detection is substring-based so a minor upstream tweak (extra trailing text,
  // or the older phrasing) still triggers the credit rotation.
  assert.equal(
    matches({
      body: JSON.stringify({
        error: {
          type: "rate_limit_error",
          message: `${LONG_CONTEXT_USAGE_CREDITS_MESSAGE} Please upgrade.`,
        },
      }),
    }),
    true,
  );
  assert.equal(
    matches({
      body: JSON.stringify({
        error: {
          type: "rate_limit_error",
          message: "Extra usage is required for long context requests.",
        },
      }),
    }),
    true,
  );
});

test("rejects an unrelated rate_limit_error message", () => {
  assert.equal(
    matches({
      body: JSON.stringify({
        error: { type: "rate_limit_error", message: "Too many requests." },
      }),
    }),
    false,
  );
});

test("rejects malformed or missing error bodies without throwing", () => {
  assert.equal(matches({ body: "not json" }), false);
  assert.equal(matches({ body: "{}" }), false);
});
