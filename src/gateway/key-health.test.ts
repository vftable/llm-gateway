// Key-health store tests: round-robin rotation, cooldown/auth-fail skipping,
// model affinity (learn/evict), persistence across a reopen, and rate-limit
// header parsing. Adapted from vsllm-proxy's key-selection tests onto the
// round-robin + SQLite-persisted store.

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, closeDatabase } from "../db";
import { createProvider } from "../repo/providers";
import { listEnabledCredentials } from "../repo/provider-keys";
import {
  KeyHealthStore,
  parseRateLimit,
  parseRateLimitHint,
  hashKey,
} from "./key-health";

function provider(
  db: ReturnType<typeof openDatabase>,
  keys: string[],
): { id: string; keys: string[] } {
  const p = createProvider(db, {
    name: "p",
    baseUrl: "https://x.example.com",
    apiKeys: keys,
  });
  return { id: p.id, keys: listEnabledCredentials(db, p.id) };
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
      store.select(p.id, p.keys, null, new Set())!.key,
      store.select(p.id, p.keys, null, new Set())!.key,
      store.select(p.id, p.keys, null, new Set())!.key,
      store.select(p.id, p.keys, null, new Set())!.key,
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
      store.select(p.id, p.keys, null, tried)!,
      store.select(p.id, p.keys, null, tried)!,
      store.select(p.id, p.keys, null, tried)!,
    ];
    picks.forEach((pk) => tried.add(pk.keyHash));
    assert.equal(new Set(picks.map((p) => p.key)).size, 3); // all distinct
    // Pool exhausted (all tried) -> still returns a key (last-resort), never null.
    assert.ok(store.select(p.id, p.keys, null, tried));
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
    assert.equal(store.select(p.id, p.keys, null, new Set())!.key, "b");
    assert.equal(store.select(p.id, p.keys, null, new Set())!.key, "b");
    // After cooldown, "a" is eligible again.
    clk.advance(61_000);
    const keys = new Set([
      store.select(p.id, p.keys, null, new Set())!.key,
      store.select(p.id, p.keys, null, new Set())!.key,
    ]);
    assert.ok(keys.has("a"));
  } finally {
    closeDatabase(db);
  }
});

test("model-scoped cooldown blocks Fable without blocking other models", () => {
  const db = openDatabase(":memory:");
  try {
    const p = provider(db, ["a", "b"]);
    const clk = clock();
    const store = new KeyHealthStore(db, clk.now);
    store.markModelCooldown(p.id, hashKey("a"), "fable", 60_000, 429, "7d_oi");

    assert.equal(
      store.select(p.id, p.keys, "claude-fable-5", new Set())!.key,
      "b",
    );
    assert.equal(store.usableCount(p.id, p.keys, "claude-fable-5"), 1);
    assert.equal(store.usableCount(p.id, p.keys, "claude-mythos-5"), 1);
    assert.equal(store.usableCount(p.id, p.keys, "claude-opus-4-8"), 2);
    assert.equal(store.usableCount(p.id, p.keys), 2);
    assert.equal(
      store.nextReadyAt(p.id, ["a"], "claude-fable-5"),
      clk.now() + 60_000,
    );
    assert.equal(store.nextReadyAt(p.id, ["a"], "claude-opus-4-8"), null);

    // Persistence is part of the control path, not merely a UI snapshot.
    const reloaded = new KeyHealthStore(db, clk.now);
    assert.equal(
      reloaded.select(p.id, p.keys, "claude-fable-5", new Set())!.key,
      "b",
    );
    assert.equal(
      reloaded.select(p.id, p.keys, "claude-opus-4-8", new Set())!.key,
      "a",
    );

    clk.advance(60_001);
    assert.equal(reloaded.usableCount(p.id, p.keys, "claude-fable-5"), 2);
  } finally {
    closeDatabase(db);
  }
});

test("clearAllRateLimits resets live and persisted cooldowns but preserves auth failures", () => {
  const db = openDatabase(":memory:");
  try {
    const p = provider(db, ["a", "b", "c"]);
    const clk = clock();
    const store = new KeyHealthStore(db, clk.now);
    store.markRateLimited(p.id, hashKey("a"), 60_000, 429, "global");
    store.markModelCooldown(p.id, hashKey("b"), "fable", 60_000, 429, "7d_oi");
    store.markAuthFailed(p.id, hashKey("c"), 401, "bad key");

    assert.equal(store.usableCount(p.id, p.keys, "claude-fable-5"), 0);
    assert.deepEqual(store.clearAllRateLimits(), {
      keysCleared: 1,
      modelCooldownsCleared: 1,
    });
    assert.equal(store.usableCount(p.id, p.keys, "claude-fable-5"), 2);
    assert.equal(store.snapshot(p.id, hashKey("c")).authFailed, true);

    const reloaded = new KeyHealthStore(db, clk.now);
    assert.equal(reloaded.usableCount(p.id, p.keys, "claude-fable-5"), 2);
    assert.equal(reloaded.snapshot(p.id, hashKey("c")).authFailed, true);
  } finally {
    closeDatabase(db);
  }
});

test("base affinity is shared across Sonnet, Opus, and Haiku", () => {
  const db = openDatabase(":memory:");
  try {
    const p = provider(db, ["a", "b"]);
    const store = new KeyHealthStore(db);
    store.recordSuccess(p.id, hashKey("b"), "claude-sonnet-5");
    assert.equal(
      store.select(p.id, p.keys, "claude-opus-4-8", new Set())!.key,
      "b",
    );
    assert.equal(
      store.select(p.id, p.keys, "claude-haiku-4-5", new Set())!.key,
      "b",
    );
    const reloaded = new KeyHealthStore(db);
    assert.equal(
      reloaded.select(p.id, p.keys, "claude-opus-4-7", new Set())!.key,
      "b",
    );
  } finally {
    closeDatabase(db);
  }
});

test("premium affinity is isolated but can overflow to base", () => {
  const db = openDatabase(":memory:");
  try {
    const p = provider(db, ["a", "b"]);
    const store = new KeyHealthStore(db);
    // Only base access is known on b; premium must not prefer it as evidence.
    store.recordSuccess(p.id, hashKey("b"), "claude-sonnet-5");
    assert.equal(
      store.select(p.id, p.keys, "claude-fable-5", new Set())!.key,
      "a",
    );

    // Premium success on a is valid overflow for a base model when no fresh
    // base-proven key is available, but fresh base proof still ranks first.
    store.recordSuccess(p.id, hashKey("a"), "claude-fable-5");
    store.markRateLimited(p.id, hashKey("b"), 60_000);
    assert.equal(
      store.select(p.id, p.keys, "claude-opus-4-8", new Set())!.key,
      "a",
    );
  } finally {
    closeDatabase(db);
  }
});

test("Fable 429 evicts premium class evidence without removing base evidence", () => {
  const db = openDatabase(":memory:");
  try {
    const p = provider(db, ["a", "b"]);
    const store = new KeyHealthStore(db, Date.now, 3);
    store.recordSuccess(p.id, hashKey("a"), "claude-opus-4-8");
    store.recordSuccess(p.id, hashKey("a"), "claude-fable-5");
    store.recordSuccess(p.id, hashKey("b"), "claude-mythos-5");
    store.recordFailure(p.id, hashKey("a"), "claude-fable-5", 429);

    assert.equal(
      store.select(p.id, p.keys, "claude-mythos-5", new Set())!.key,
      "b",
    );
    assert.equal(
      store.select(p.id, p.keys, "claude-sonnet-5", new Set())!.key,
      "a",
    );
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
      assert.equal(store.select(p.id, p.keys, null, new Set())!.key, "b");
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
      assert.equal(store.select(p.id, p.keys, "gpt", new Set())!.key, "b");
    // Three failures evict the pairing.
    store.recordFailure(p.id, hashKey("b"), "gpt");
    store.recordFailure(p.id, hashKey("b"), "gpt");
    store.recordFailure(p.id, hashKey("b"), "gpt");
    // No affinity now -> round-robin across all keys again (not pinned to b).
    const picks = new Set([
      store.select(p.id, p.keys, "gpt", new Set())!.key,
      store.select(p.id, p.keys, "gpt", new Set())!.key,
      store.select(p.id, p.keys, "gpt", new Set())!.key,
    ]);
    assert.ok(picks.size > 1);
  } finally {
    closeDatabase(db);
  }
});

test("sticky: a successful key is reused for the same model instead of round-robining", () => {
  const db = openDatabase(":memory:");
  try {
    const p = provider(db, ["a", "b", "c"]);
    const store = new KeyHealthStore(db);
    // "a" succeeds for "gpt" first (round-robin's natural first pick).
    store.recordSuccess(p.id, hashKey("a"), "gpt");
    // Every subsequent select for "gpt" reuses "a" — no spreading across b/c,
    // even though a fresh call with no `tried` set would otherwise round-robin.
    for (let i = 0; i < 6; i++)
      assert.equal(store.select(p.id, p.keys, "gpt", new Set())!.key, "a");
    // A different model is unaffected by "gpt"'s sticky pin — it has no
    // sticky/affinity of its own yet, so it falls through to round-robin
    // (cursor untouched by the sticky picks above, since those bypass
    // rrPick entirely — starts fresh at "a").
    assert.equal(store.select(p.id, p.keys, "claude", new Set())!.key, "a");
  } finally {
    closeDatabase(db);
  }
});

test("sticky: falls over to another key once the sticky key goes unhealthy", () => {
  const db = openDatabase(":memory:");
  try {
    const p = provider(db, ["a", "b", "c"]);
    const store = new KeyHealthStore(db);
    store.recordSuccess(p.id, hashKey("a"), "gpt");
    assert.equal(store.select(p.id, p.keys, "gpt", new Set())!.key, "a");
    // "a" gets rate-limited — sticky key is unhealthy, select() must skip it.
    store.markRateLimited(p.id, hashKey("a"), 60_000);
    const pick = store.select(p.id, p.keys, "gpt", new Set())!.key;
    assert.notEqual(pick, "a");
    // The new key proves itself and becomes the new sticky pick.
    store.recordSuccess(p.id, hashKey(pick), "gpt");
    for (let i = 0; i < 3; i++)
      assert.equal(store.select(p.id, p.keys, "gpt", new Set())!.key, pick);
  } finally {
    closeDatabase(db);
  }
});

test("sticky: a confirmed auth failure clears the sticky pointer for every model", () => {
  const db = openDatabase(":memory:");
  try {
    const p = provider(db, ["a", "b"]);
    const store = new KeyHealthStore(db);
    store.recordSuccess(p.id, hashKey("a"), "gpt");
    store.recordSuccess(p.id, hashKey("a"), "claude");
    assert.equal(store.select(p.id, p.keys, "gpt", new Set())!.key, "a");
    store.markAuthFailed(p.id, hashKey("a"));
    // Both models must fall through to "b" — a dead key is never sticky.
    assert.equal(store.select(p.id, p.keys, "gpt", new Set())!.key, "b");
    assert.equal(store.select(p.id, p.keys, "claude", new Set())!.key, "b");
  } finally {
    closeDatabase(db);
  }
});

test("sticky pointer persists across store reopen (same DB)", () => {
  const db = openDatabase(":memory:");
  try {
    const p = provider(db, ["a", "b", "c"]);
    const s1 = new KeyHealthStore(db);
    s1.recordSuccess(p.id, hashKey("b"), "gpt");
    const s2 = new KeyHealthStore(db);
    for (let i = 0; i < 3; i++)
      assert.equal(s2.select(p.id, p.keys, "gpt", new Set())!.key, "b");
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
    assert.equal(s2.select(p.id, p.keys, null, new Set())!.key, "b"); // "a" still disabled
    assert.equal(s2.select(p.id, p.keys, "m", new Set())!.key, "b"); // affinity restored
  } finally {
    closeDatabase(db);
  }
});

test("keyless provider yields null (no auth attached)", () => {
  const db = openDatabase(":memory:");
  try {
    const p = provider(db, []);
    const store = new KeyHealthStore(db);
    assert.equal(store.select(p.id, p.keys, null, new Set()), null);
    assert.equal(store.usableCount(p.id, p.keys), 0);
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
    assert.equal(store.usableCount(p.id, p.keys), 3);
    store.markAuthFailed(p.id, hashKey("a"));
    store.markRateLimited(p.id, hashKey("b"), 30_000);
    assert.equal(store.usableCount(p.id, p.keys), 1);
    clk.advance(31_000);
    assert.equal(store.usableCount(p.id, p.keys), 2); // b recovered, a still failed
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

test("parseRateLimitHint understands standard/de-facto reset headers", () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(parseRateLimitHint({ "ratelimit-reset": "7" }, now), {
    ms: 7000,
    resetAt: now + 7000,
    source: "ratelimit-reset",
  });
  const epochSeconds = Math.floor((now + 11_000) / 1000);
  const xReset = parseRateLimitHint(
    { "x-ratelimit-reset": String(epochSeconds) },
    now,
  );
  assert.ok(Math.abs(xReset.ms - 11_000) <= 1000);
  assert.equal(xReset.source, "x-ratelimit-reset");
});

test("parseRateLimitHint falls back to Anthropic's unified-quota reset header", () => {
  const now = 1_700_000_000_000;
  const epochSeconds = Math.floor((now + 4 * 3_600_000) / 1000);
  const hint = parseRateLimitHint(
    { "anthropic-ratelimit-unified-reset": String(epochSeconds) },
    now,
  );
  assert.ok(Math.abs(hint.ms - 4 * 3_600_000) <= 1000);
  assert.equal(hint.source, "anthropic-ratelimit-unified-reset");
  // Standard headers still win when both are present — the unified header
  // is a fallback for when Anthropic's 429 carries no standard header.
  const withRetryAfter = parseRateLimitHint(
    {
      "retry-after": "5",
      "anthropic-ratelimit-unified-reset": String(epochSeconds),
    },
    now,
  );
  assert.equal(withRetryAfter.source, "retry-after");
  assert.equal(withRetryAfter.ms, 5000);
});

test("snapshot surfaces auth failure and rate-limit error metadata", () => {
  const db = openDatabase(":memory:");
  try {
    const p = provider(db, ["a", "b"]);
    const clk = clock();
    const store = new KeyHealthStore(db, clk.now);
    store.markAuthFailed(p.id, hashKey("a"), 401, "bad key");
    store.markRateLimited(p.id, hashKey("b"), 30_000, 429, "too many");
    const dead = store.snapshot(p.id, hashKey("a"));
    assert.equal(dead.authFailed, true);
    assert.equal(dead.lastErrorStatus, 401);
    assert.equal(dead.lastError, "bad key");
    const limited = store.snapshot(p.id, hashKey("b"));
    assert.equal(limited.usable, false);
    assert.equal(limited.lastErrorStatus, 429);
    assert.equal(
      limited.rateLimitedUntilIso,
      new Date(clk.now() + 30_000).toISOString(),
    );
  } finally {
    closeDatabase(db);
  }
});

test("markAuthFailed accumulates a lifetime count that survives recordSuccess", () => {
  const db = openDatabase(":memory:");
  try {
    const p = provider(db, ["a"]);
    const store = new KeyHealthStore(db);
    store.markAuthFailed(p.id, hashKey("a"), 401, "bad key");
    store.markAuthFailed(p.id, hashKey("a"), 401, "bad key");
    assert.equal(store.snapshot(p.id, hashKey("a")).authFailCount, 2);
    // A later success clears the live authFailed/usable flags but the
    // lifetime counter is history, not current state — it must not reset.
    store.recordSuccess(p.id, hashKey("a"), null);
    const after = store.snapshot(p.id, hashKey("a"));
    assert.equal(after.authFailed, false);
    assert.equal(after.authFailCount, 2);
    // Reloading from a fresh store (simulating a process restart) must
    // still see the persisted count.
    const reloaded = new KeyHealthStore(db);
    assert.equal(reloaded.snapshot(p.id, hashKey("a")).authFailCount, 2);
  } finally {
    closeDatabase(db);
  }
});
