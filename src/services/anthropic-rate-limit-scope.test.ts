import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyAnthropicRateLimit } from "./anthropic-rate-limit-scope";

const now = 1_700_000_000_000;
const reset = Math.floor((now + 3_600_000) / 1000);
const headers = (overrides: Record<string, string> = {}) => ({
  "anthropic-ratelimit-unified-status": "rate_limited",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.5",
  "anthropic-ratelimit-unified-7d-status": "allowed_warning",
  "anthropic-ratelimit-unified-7d-utilization": "0.9",
  "anthropic-ratelimit-unified-7d_oi-status": "rejected",
  "anthropic-ratelimit-unified-7d_oi-utilization": "1",
  "anthropic-ratelimit-unified-7d_oi-reset": String(reset),
  ...overrides,
});

function classify(
  overrides: Partial<Parameters<typeof classifyAnthropicRateLimit>[0]> = {},
) {
  return classifyAnthropicRateLimit(
    {
      status: 429,
      catalogId: "claude-code",
      upstreamModel: "claude-fable-5",
      headers: headers(),
      ...overrides,
    },
    now,
  );
}

test("classifies 7d_oi-only exhaustion as Fable-scoped", () => {
  assert.deepEqual(classify(), {
    scope: "model",
    modelClass: "fable",
    resetAt: reset * 1000,
    reason: "Fable 7d_oi exhausted while general 5h/7d quota remains available",
  });
});

test("general quota exhaustion or ambiguity remains global", () => {
  assert.equal(
    classify({
      headers: headers({ "anthropic-ratelimit-unified-5h-status": "rejected" }),
    }).scope,
    "global",
  );
  const missingFiveHour = headers();
  delete (missingFiveHour as Record<string, string>)[
    "anthropic-ratelimit-unified-5h-status"
  ];
  delete (missingFiveHour as Record<string, string>)[
    "anthropic-ratelimit-unified-5h-utilization"
  ];
  assert.equal(classify({ headers: missingFiveHour }).scope, "global");
  assert.equal(classify({ headers: {} }).scope, "global");
});

test("scope covers Fable and Mythos but not unrelated models/providers/statuses", () => {
  assert.equal(classify({ upstreamModel: "claude-mythos-5" }).scope, "model");
  assert.equal(
    classify({ upstreamModel: "claude-mythos-preview" }).scope,
    "model",
  );
  assert.equal(classify({ upstreamModel: "claude-opus-4-8" }).scope, "global");
  assert.equal(classify({ catalogId: "anthropic" }).scope, "global");
  assert.equal(classify({ status: 500 }).scope, "global");
});

test("utilization-only signals are accepted conservatively", () => {
  const utilizationOnly = headers();
  for (const key of ["5h", "7d", "7d_oi"])
    delete (utilizationOnly as Record<string, string>)[
      `anthropic-ratelimit-unified-${key}-status`
    ];
  assert.equal(classify({ headers: utilizationOnly }).scope, "model");
  (utilizationOnly as Record<string, string>)[
    "anthropic-ratelimit-unified-7d-utilization"
  ] = "1";
  assert.equal(classify({ headers: utilizationOnly }).scope, "global");
});

test("uses representative reset only when 7d_oi reset is absent", () => {
  const fallback = headers({
    "anthropic-ratelimit-unified-reset": String(reset + 60),
  });
  delete (fallback as Record<string, string>)[
    "anthropic-ratelimit-unified-7d_oi-reset"
  ];
  const result = classify({ headers: fallback });
  assert.equal(result.scope, "model");
  if (result.scope === "model")
    assert.equal(result.resetAt, (reset + 60) * 1000);
});
