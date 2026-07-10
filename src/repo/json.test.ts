// Shared safe-JSON parse helpers used across the repo layer for TEXT columns.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonObject, parseJsonArray, isString } from "./json";

test("parseJsonObject returns a parsed plain object", () => {
  assert.deepEqual(parseJsonObject('{"a":1}', {}), { a: 1 });
});

test("parseJsonObject falls back on null/empty/malformed/non-object", () => {
  assert.deepEqual(parseJsonObject(null, { d: 1 }), { d: 1 });
  assert.deepEqual(parseJsonObject("", { d: 1 }), { d: 1 });
  assert.deepEqual(parseJsonObject("{not json", { d: 1 }), { d: 1 });
  assert.deepEqual(parseJsonObject("[1,2]", { d: 1 }), { d: 1 }); // array → fallback
  assert.deepEqual(parseJsonObject("42", { d: 1 }), { d: 1 }); // primitive → fallback
});

test("parseJsonObject supports a nullable fallback", () => {
  assert.equal(
    parseJsonObject<Record<string, unknown> | null>(null, null),
    null,
  );
  assert.equal(
    parseJsonObject<Record<string, unknown> | null>("[]", null),
    null,
  );
});

test("parseJsonArray returns arrays, [] otherwise", () => {
  assert.deepEqual(parseJsonArray('["a","b"]'), ["a", "b"]);
  assert.deepEqual(parseJsonArray(null), []);
  assert.deepEqual(parseJsonArray('{"a":1}'), []); // object → []
  assert.deepEqual(parseJsonArray("nope"), []);
});

test("parseJsonArray applies an element guard", () => {
  assert.deepEqual(parseJsonArray('["a",1,"b",null]', isString), ["a", "b"]);
});
