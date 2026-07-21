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

test("rejects other statuses, providers, and models", () => {
  assert.equal(matches({ status: 400 }), false);
  assert.equal(matches({ catalogId: "anthropic" }), false);
  assert.equal(matches({ upstreamModel: "claude-opus-4-6" }), false);
  assert.equal(matches({ upstreamModel: "claude-sonnet-4-5" }), false);
});

test("rejects different error types and non-exact messages", () => {
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
  assert.equal(
    matches({
      body: JSON.stringify({
        error: {
          type: "rate_limit_error",
          message: `${LONG_CONTEXT_USAGE_CREDITS_MESSAGE} `,
        },
      }),
    }),
    false,
  );
});

test("rejects malformed or missing error bodies without throwing", () => {
  assert.equal(matches({ body: "not json" }), false);
  assert.equal(matches({ body: "{}" }), false);
});
