import { test } from "node:test";
import assert from "node:assert/strict";
import type { Database as DB } from "better-sqlite3";
import { openDatabase, closeDatabase } from "../db";
import {
  insertRequestLog,
  listRequestLogs,
  lastUsedByKey,
} from "./request-logs";

// Insert a log row with an explicit ts + status so MAX(ts) ordering and the
// "any status counts as a use" rule can be asserted (insertRequestLog stamps
// ts=now, which can't distinguish rows within a test).
function insertAt(
  db: DB,
  providerId: string,
  keyHash: string | null,
  ts: string,
  status: number | null,
): void {
  db.prepare(
    `INSERT INTO request_logs (ts, provider_id, upstream_key_hash, status, stream)
     VALUES (?, ?, ?, ?, 0)`,
  ).run(ts, providerId, keyHash, status);
}

const base = {
  apiKeyId: null,
  apiKeyName: null,
  userId: null,
  model: "model",
  providerId: "provider",
  providerName: "Provider",
  upstreamModel: "upstream",
  status: 200,
  inputTokens: 1,
  outputTokens: 2,
  cachedTokens: null,
  latencyMs: 10,
  client: null,
  path: "/v1/messages",
  stream: false,
  error: null,
  debugRequest: null,
  debugResponse: null,
};

test("request logs round-trip immutable upstream key mask without exposing hash", () => {
  const db = openDatabase(":memory:");
  try {
    insertRequestLog(db, {
      ...base,
      upstreamKeyHash: "secret-hash",
      upstreamKeyMask: "sk-ant…1234",
    });
    const [log] = listRequestLogs(db);
    assert.equal(log.upstreamKeyMask, "sk-ant…1234");
    assert.equal("upstreamKeyHash" in log, false);
    const stored = db
      .prepare(
        "SELECT upstream_key_hash, upstream_key_mask FROM request_logs WHERE id = ?",
      )
      .get(log.id) as Record<string, unknown>;
    assert.equal(stored.upstream_key_hash, "secret-hash");
    assert.equal(stored.upstream_key_mask, "sk-ant…1234");
  } finally {
    closeDatabase(db);
  }
});

test("request logs preserve null attribution for keyless/pre-attempt rows", () => {
  const db = openDatabase(":memory:");
  try {
    insertRequestLog(db, {
      ...base,
      upstreamKeyHash: null,
      upstreamKeyMask: null,
    });
    const [log] = listRequestLogs(db);
    assert.equal(log.upstreamKeyMask, null);
  } finally {
    closeDatabase(db);
  }
});

test("lastUsedByKey returns the newest ts per key, any status, scoped to provider", () => {
  const db = openDatabase(":memory:");
  try {
    // Key A: two hits — the newest wins. Its newest is a 429, which still
    // counts as a use (the dashboard sorts by "last exercised", not success).
    insertAt(db, "p1", "hashA", "2026-07-20T10:00:00.000Z", 200);
    insertAt(db, "p1", "hashA", "2026-07-22T08:30:00.000Z", 429);
    // Key B: single older hit.
    insertAt(db, "p1", "hashB", "2026-07-21T12:00:00.000Z", 200);
    // A newer hit for the SAME hash under a different provider must not leak in.
    insertAt(db, "p2", "hashA", "2026-07-22T23:59:00.000Z", 200);
    // Null-hash rows (keyless / pre-attempt) are ignored.
    insertAt(db, "p1", null, "2026-07-22T09:00:00.000Z", 200);

    const map = lastUsedByKey(db, "p1");
    assert.equal(map.get("hashA"), "2026-07-22T08:30:00.000Z");
    assert.equal(map.get("hashB"), "2026-07-21T12:00:00.000Z");
    assert.equal(map.size, 2);
  } finally {
    closeDatabase(db);
  }
});
