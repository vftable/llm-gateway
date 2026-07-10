// applyAuthHeaders: the single source of the provider auth-scheme branching used
// by both the engine's outbound request builder and the admin model/probe helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAuthHeaders } from "./base";

test("bearer sets Authorization only", () => {
  const h = applyAuthHeaders({}, "bearer", "sk-1");
  assert.deepEqual(h, { authorization: "Bearer sk-1" });
});

test("xapikey sets x-api-key only", () => {
  const h = applyAuthHeaders({}, "xapikey", "sk-2");
  assert.deepEqual(h, { "x-api-key": "sk-2" });
});

test("both sets Authorization AND x-api-key", () => {
  const h = applyAuthHeaders({}, "both", "sk-3");
  assert.deepEqual(h, { authorization: "Bearer sk-3", "x-api-key": "sk-3" });
});

test("passthrough sets no auth header (client auth forwarded)", () => {
  assert.deepEqual(applyAuthHeaders({}, "passthrough", "sk-4"), {});
});

test("a null/empty key adds nothing regardless of scheme", () => {
  assert.deepEqual(applyAuthHeaders({}, "bearer", null), {});
  assert.deepEqual(applyAuthHeaders({}, "both", ""), {});
  assert.deepEqual(applyAuthHeaders({}, "xapikey", undefined), {});
});

test("mutates + returns the same object, preserving existing headers", () => {
  const base = { host: "api.example.com" };
  const out = applyAuthHeaders(base, "bearer", "sk-5");
  assert.equal(out, base); // same reference
  assert.deepEqual(out, {
    host: "api.example.com",
    authorization: "Bearer sk-5",
  });
});
