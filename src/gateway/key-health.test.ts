// Key-health store tests: round-robin rotation, cooldown/auth-fail skipping,
// model affinity (learn/evict), persistence across a reopen, and rate-limit
// header parsing. Adapted from vsllm-proxy's key-selection tests onto the
// round-robin + SQLite-persisted store.

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, closeDatabase } from "../db";
import { createProvider } from "../repo/providers";
import { KeyHealthStore, parseRateLimit, hashKey } from "./key-health";
import type { Provider } from "../types";

function provider(db: ReturnType<typeof openDatabase>, keys: string[]): Provider {
  return createProvider(db, {
    name: "p",
    baseUrl: "https://x.example.com",
    apiKeys: keys,
  });
}

// A controllable clock so cooldown tests are deterministic.
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("round-robin rotates keys in order", () => {
  const db = openDatabase(":memory:");
  try {
    const p = provider(db, ["a", "b", "c"]);
    const store = new KeyHealthStore(db);
    const seen = [
      store.select(p, null, new Set())!.key,
      store.select(p, null, new Set())!.key,
      store.select(p, null, new Set())!.key,
      store.select(p, null, new Set())!.key,
    ];
    // Fresh picks each call (empty tried set) cycle a,b,c,a.
    assert.deepEqual(seen, ["a", "b", "c", "a"]);
  } finally {
    closeDatabase(db);
  }
});

test("select skips already-tried keys within a request", () => {
  const db = openDatabase(":memory:");
  try {
    const p = provider(db, ["a", "b", "c"]);
    const store = new KeyHealthStore(db);
    const tried = new Set<string>();
    const picks = [
      store.select(p, null, tried)!,
      store.select(p, null, tried)!,
      store.select(p, null, tried)!,
    ];
    picks.forEach((pk) => tried.add(pk.keyHash));
    assert.equal(new Set(picks.map((p) => p.key)).size, 3); // all distinct
    // Pool exhausted (all tried) -> still returns a key (last-resort), never null.
    assert.ok(store.select(p, null, tried));
  } finally {
    closeDatabase(db);
  }
});

test("rate-limited keys are skipped until cooldown expires", () => {
  const db = openDatabase(":memory:");
  try {
    const p = provider(db, ["a", "b"]);
    const clk = clock();
    const store = new KeyHealthStore(db, clk.now);
    // Rate-limit "a" for 60s.
    store.markRateLimited(p.id, hashKey("a"), 60_000);
    // Fresh selects should now only yield "b".
    assert.equal(store.select(p, null, new Set())!.key, "b");
    assert.equal(store.select(p, null, new Set())!.key, "b");
    // After cooldown, "a" is eligible again.
    clk.advance(61_000);
    const keys = new Set([
      store.select(p, null, new Set())!.key,
      store.select(p, null, new Set())!.key,
    ]);
    assert.ok(keys.has("a"));
  } finally {
    closeDatabase(db);
  }
});

test("auth-failed keys are skipped", () => {
  const db = openDatabase(":memory:");
  try {
    const p = provider(db, ["a", "b"]);
    const store = new KeyHealthStore(db);
    store.markAuthFailed(p.id, hashKey("a"));
    for (let i = 0; i < 4; i++)
      assert.equal(store.select(p, null, new Set())!.key, "b");
  } finally {
    closeDatabase(db);
  }
});

test("model affinity: proven key is preferred, evicted after threshold", () => {
  const db = openDatabase(":memory:");
  try {
    const p = provider(db, ["a", "b", "c"]);
    const store = new KeyHealthStore(db, Date.now, 3);
    // Learn that "b" serves "gpt".
    store.recordSuccess(p.id, hashKey("b"), "gpt");
    // With affinity, "gpt" always routes to "b".
    for (let i = 0; i < 5; i++)
      assert.equal(store.select(p, "gpt", new Set())!.key, "b");
    // Three failures evict the pairing.
    store.recordFailure(p.id, hashKey("b"), "gpt");
    store.recordFailure(p.id, hashKey("b"), "gpt");
    store.recordFailure(p.id, hashKey("b"), "gpt");
    // No affinity now -> round-robin across all keys again (not pinned to b).
    const picks = new Set([
      store.select(p, "gpt", new Set())!.key,
      store.select(p, "gpt", new Set())!.key,
      store.select(p, "gpt", new Set())!.key,
    ]);
    assert.ok(picks.size > 1);
  } finally {
    closeDatabase(db);
  }
});

test("health persists across store reopen (same DB)", () => {
  const db = openDatabase(":memory:");
  try {
    const p = provider(db, ["a", "b"]);
    const s1 = new KeyHealthStore(db);
    s1.markAuthFailed(p.id, hashKey("a"));
    s1.recordSuccess(p.id, hashKey("b"), "m");
    // A fresh store instance re-hydrates from SQLite.
    const s2 = new KeyHealthStore(db);
    assert.equal(s2.select(p, null, new Set())!.key, "b"); // "a" still disabled
    assert.equal(s2.select(p, "m", new Set())!.key, "b"); // affinity restored
  } finally {
    closeDatabase(db);
  }
});

test("keyless provider yields null (no auth attached)", () => {
  const db = openDatabase(":memory:");
  try {
    const p = provider(db, []);
    const store = new KeyHealthStore(db);
    assert.equal(store.select(p, null, new Set()), null);
    assert.equal(store.usableCount(p), 0);
  } finally {
    closeDatabase(db);
  }
});

test("usableCount excludes cooling-down and auth-failed keys", () => {
  const db = openDatabase(":memory:");
  try {
    const p = provider(db, ["a", "b", "c"]);
    const clk = clock();
    const store = new KeyHealthStore(db, clk.now);
    assert.equal(store.usableCount(p), 3);
    store.markAuthFailed(p.id, hashKey("a"));
    store.markRateLimited(p.id, hashKey("b"), 30_000);
    assert.equal(store.usableCount(p), 1);
    clk.advance(31_000);
    assert.equal(store.usableCount(p), 2); // b recovered, a still failed
  } finally {
    closeDatabase(db);
  }
});

test("parseRateLimit: retry-after-ms > retry-after secs > date > default", () => {
  const now = 1_000_000;
  assert.equal(parseRateLimit({ "retry-after-ms": "1500" }, now), 1500);
  assert.equal(parseRateLimit({ "retry-after": "2" }, now), 2000);
  assert.equal(parseRateLimit({}, now), 60_000);
  const when = new Date(now + 5000).toUTCString();
  const parsed = parseRateLimit({ "retry-after": when }, now);
  // HTTP-date has second resolution; allow a 1s slop.
  assert.ok(Math.abs(parsed - 5000) <= 1000);
});
