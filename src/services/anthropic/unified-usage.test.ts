import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterUnifiedRateLimitHeaders,
  parseUnifiedRateLimitHeaders,
  unifiedRateLimitToUsageWindows,
  unifiedStatusMessage,
} from "./unified-usage";

const HEADERS = {
  date: "Tue, 21 Jul 2026 01:58:48 GMT",
  "anthropic-ratelimit-unified-status": "allowed",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-reset": "1784607600",
  "anthropic-ratelimit-unified-5h-utilization": "0.05",
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-reset": "1785031200",
  "anthropic-ratelimit-unified-7d-utilization": "0.14",
  "anthropic-ratelimit-unified-7d_oi-status": "allowed",
  "anthropic-ratelimit-unified-7d_oi-reset": "1785031200",
  "anthropic-ratelimit-unified-7d_oi-utilization": "0.27",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-fallback-percentage": "0.5",
  "anthropic-ratelimit-unified-reset": "1784607600",
  "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
  "anthropic-ratelimit-unified-overage-status": "rejected",
  "request-id": "req_secret",
};

test("filters only unified rate-limit headers", () => {
  const filtered = filterUnifiedRateLimitHeaders(HEADERS);
  assert.equal(filtered.date, undefined);
  assert.equal(filtered["request-id"], undefined);
  assert.equal(filtered["anthropic-ratelimit-unified-status"], "allowed");
  assert.equal(Object.keys(filtered).length, 15);
});

test("parses supplied 5h, weekly, and 7d_oi windows", () => {
  const info = parseUnifiedRateLimitHeaders(HEADERS)!;
  assert.equal(info.status, "allowed");
  assert.equal(info.representativeWindowKey, "5h");
  assert.equal(info.fallbackPercentage, 0.5);
  assert.equal(info.resetsAt, new Date(1784607600 * 1000).toISOString());
  assert.deepEqual(
    info.windows.map((window) => [window.key, window.utilization]),
    [
      ["5h", 0.05],
      ["7d", 0.14],
      ["7d_oi", 0.27],
    ],
  );

  const windows = unifiedRateLimitToUsageWindows(info);
  assert.deepEqual(
    windows.map((window) => [window.id, window.label, window.used]),
    [
      ["unified-5h", "Prompts (5h)", 5],
      ["unified-7d", "Prompts (weekly)", 14],
      ["unified-7d_oi", "Prompts (Fable)", 27],
    ],
  );
  assert.ok(windows.every((window) => window.limit === 100));
});

test("discovers future windows and handles malformed values safely", () => {
  const info = parseUnifiedRateLimitHeaders({
    "anthropic-ratelimit-unified-future-status": "allowed_warning",
    "anthropic-ratelimit-unified-future-utilization": "1.4",
    "anthropic-ratelimit-unified-future-reset": "bad",
    "anthropic-ratelimit-unified-negative-status": "allowed",
    "anthropic-ratelimit-unified-negative-utilization": "-1",
  })!;
  const future = info.windows.find((window) => window.key === "future")!;
  assert.equal(future.utilization, 1);
  assert.equal(future.resetsAt, undefined);
  const negative = info.windows.find((window) => window.key === "negative")!;
  assert.equal(negative.utilization, undefined);
  assert.deepEqual(
    unifiedRateLimitToUsageWindows(info).map((window) => window.label),
    ["Window (future)", "Window (negative)"],
  );
});

test("accepts string-array values and representative reset fallback", () => {
  const info = parseUnifiedRateLimitHeaders({
    "anthropic-ratelimit-unified-status": ["allowed", "rejected"],
    "anthropic-ratelimit-unified-reset": "1784607600",
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.1",
  })!;
  assert.equal(info.status, "allowed");
  assert.equal(
    unifiedRateLimitToUsageWindows(info)[0].resetsAt,
    new Date(1784607600 * 1000).toISOString(),
  );
});

test("status and overage messages are operator friendly", () => {
  assert.equal(
    unifiedStatusMessage({ status: "allowed_warning" }),
    "Approaching rate limit",
  );
  assert.equal(
    unifiedStatusMessage({
      status: "rejected",
      overageStatus: "rejected",
      overageDisabledReason: "org_level_disabled",
    }),
    "Rate limit exhausted · Overage rejected · org level disabled",
  );
});

test("no unified headers returns null and output is JSON finite", () => {
  assert.equal(parseUnifiedRateLimitHeaders({ date: "now" }), null);
  const windows = unifiedRateLimitToUsageWindows(
    parseUnifiedRateLimitHeaders(HEADERS)!,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(windows)), windows);
  assert.ok(windows.every((window) => Number.isFinite(window.used)));
});
