import assert from "node:assert/strict";
import { test } from "node:test";
import { formatUpstreamError, isSensitiveHeaderName } from "./logger";

const base = {
  status: 429,
  provider: "claude-code",
  upstreamModel: "claude-fable-5",
  path: "/v1/messages",
  keyMask: "sk-ant-…abcd",
};

test("formatUpstreamError expands JSON, sorts headers, and redacts secrets", () => {
  const output = formatUpstreamError({
    ...base,
    headers: {
      "x-request-id": "req_123",
      "set-cookie": ["session=secret", "other=secret"],
      Authorization: "Bearer secret",
      "content-type": "application/json; charset=utf-8",
      "anthropic-ratelimit-unified-7d_oi-status": "rejected",
    },
    body: JSON.stringify({ error: { type: "rate_limit", message: "full" } }),
    category: "rate limited",
    details: { rateLimitSource: "retry-after", rateLimitMs: 5000 },
  });

  assert.match(output, /UPSTREAM NON-2XX 429 · rate limited/);
  assert.match(output, /provider=claude-code · model=claude-fable-5/);
  assert.match(output, /authorization: <redacted>/);
  assert.match(output, /set-cookie: <redacted>/);
  assert.doesNotMatch(output, /Bearer secret|session=secret/);
  assert.match(output, /anthropic-ratelimit-unified-7d_oi-status: rejected/);
  assert.match(output, /\n      "error": \{/);
  assert.ok(
    output.indexOf("anthropic-ratelimit") < output.indexOf("content-type"),
    "headers should be sorted",
  );
});

test("formatUpstreamError preserves malformed JSON and large bodies", () => {
  const largeTail = "END-OF-FULL-BODY";
  const body = `${"x".repeat(9000)}\n${largeTail}`;
  const output = formatUpstreamError({
    ...base,
    status: 400,
    headers: { "content-type": "application/json" },
    body,
  });
  assert.match(output, new RegExp(largeTail));
  assert.match(output, /Response body\n    x{100}/);
});

test("formatUpstreamError can emit ANSI structure colors", () => {
  const output = formatUpstreamError(
    { ...base, headers: {}, body: "plain\ntext" },
    true,
  );
  assert.match(output, /\x1b\[/);
  assert.match(output, /    plain\n    text/);
});

test("sensitive header detection is case-insensitive and conservative", () => {
  for (const name of [
    "Authorization",
    "proxy-authorization",
    "X-API-Key",
    "x-auth-token",
    "client-secret",
    "Set-Cookie",
  ]) {
    assert.equal(isSensitiveHeaderName(name), true, name);
  }
  assert.equal(isSensitiveHeaderName("x-request-id"), false);
  assert.equal(
    isSensitiveHeaderName("anthropic-ratelimit-unified-status"),
    false,
  );
});
