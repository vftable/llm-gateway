import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bareResponseHeaders,
  finalizeResponseHeaders,
  seedResponseHeaders,
} from "./utils";

test("seedResponseHeaders lowercases names, strips hop-by-hop and preserves arrays", () => {
  const headers = seedResponseHeaders({
    Connection: "keep-alive",
    "X-Request-Id": "req-1",
    "set-cookie": ["a=1", "b=2"],
    "content-encoding": "gzip",
  });
  assert.deepEqual(headers, {
    "x-request-id": "req-1",
    "set-cookie": ["a=1", "b=2"],
    "content-encoding": "gzip",
  });

  assert.deepEqual(
    seedResponseHeaders(
      { "content-encoding": "gzip", "x-test": "ok" },
      { stripEncoding: true },
    ),
    { "x-test": "ok" },
  );
});

test("bareResponseHeaders removes provider metadata and keeps representation headers", () => {
  assert.deepEqual(
    bareResponseHeaders({
      "content-type": "application/json",
      "content-length": "12",
      "content-encoding": "gzip",
      "x-request-id": "req-secret",
      "anthropic-ratelimit-unified-status": "allowed",
      "x-ratelimit-remaining": "99",
      "cf-ray": "infra-secret",
      "set-cookie": ["account=secret"],
    }),
    {
      "content-type": "application/json",
      "content-length": "12",
      "content-encoding": "gzip",
    },
  );
});

test("finalizeResponseHeaders preserves hook edits and owns framing fields", () => {
  const buffered = finalizeResponseHeaders(
    {
      "x-added": "yes",
      "content-length": "wrong",
      "content-type": "text/plain",
      "set-cookie": ["a=1", "b=2"],
    },
    { contentLength: 12, contentType: "application/json" },
  );
  assert.deepEqual(buffered, {
    "x-added": "yes",
    "content-length": "12",
    "content-type": "application/json",
    "set-cookie": ["a=1", "b=2"],
  });

  const stream = finalizeResponseHeaders(
    { "content-length": "99", "x-added": "yes" },
    { sse: true },
  );
  assert.equal(stream["content-length"], undefined);
  assert.equal(stream["cache-control"], "no-cache, no-transform");
  assert.equal(stream["x-accel-buffering"], "no");
  assert.equal(stream["x-added"], "yes");
});
