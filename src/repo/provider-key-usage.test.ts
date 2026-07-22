import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, closeDatabase } from "../db";
import { createProvider, deleteProvider } from "./providers";
import {
  getUnifiedUsage,
  hasUnifiedUsage,
  upsertUnifiedUsage,
} from "./provider-key-usage";

function setup() {
  const db = openDatabase(":memory:");
  createProvider(db, {
    id: "provider-1",
    name: "Claude Code",
    baseUrl: "https://api.anthropic.com",
  });
  return db;
}

test("unified usage snapshot upserts latest values atomically", () => {
  const db = setup();
  try {
    upsertUnifiedUsage(
      db,
      "provider-1",
      "hash-1",
      { "anthropic-ratelimit-unified-5h-utilization": "0.1" },
      200,
      "2026-07-21T01:00:00.000Z",
    );
    upsertUnifiedUsage(
      db,
      "provider-1",
      "hash-1",
      { "anthropic-ratelimit-unified-5h-utilization": "0.5" },
      429,
      "2026-07-21T02:00:00.000Z",
    );
    const snapshot = getUnifiedUsage(db, "provider-1", "hash-1")!;
    assert.deepEqual(snapshot.headers, {
      "anthropic-ratelimit-unified-5h-utilization": "0.5",
    });
    assert.equal(snapshot.httpStatus, 429);
    assert.equal(snapshot.capturedAt, "2026-07-21T02:00:00.000Z");
    assert.equal(hasUnifiedUsage(db, "provider-1", "hash-1"), true);
  } finally {
    closeDatabase(db);
  }
});

test("base-model success preserves omitted Fable 7d_oi usage", () => {
  const db = setup();
  try {
    upsertUnifiedUsage(
      db,
      "provider-1",
      "hash-1",
      {
        "anthropic-ratelimit-unified-5h-utilization": "0.1",
        "anthropic-ratelimit-unified-7d_oi-utilization": "0.27",
        "anthropic-ratelimit-unified-7d_oi-reset": "1785031200",
      },
      200,
      "2026-07-21T01:00:00.000Z",
    );
    upsertUnifiedUsage(
      db,
      "provider-1",
      "hash-1",
      { "anthropic-ratelimit-unified-5h-utilization": "0.5" },
      200,
      "2026-07-21T02:00:00.000Z",
    );

    assert.deepEqual(getUnifiedUsage(db, "provider-1", "hash-1")!.headers, {
      "anthropic-ratelimit-unified-7d_oi-utilization": "0.27",
      "anthropic-ratelimit-unified-7d_oi-reset": "1785031200",
      "anthropic-ratelimit-unified-5h-utilization": "0.5",
    });
  } finally {
    closeDatabase(db);
  }
});

test("Fable success overwrites prior 7d_oi usage", () => {
  const db = setup();
  try {
    upsertUnifiedUsage(
      db,
      "provider-1",
      "hash-1",
      {
        "anthropic-ratelimit-unified-7d_oi-utilization": "0.27",
        "anthropic-ratelimit-unified-7d_oi-reset": "1785031200",
      },
      200,
    );
    upsertUnifiedUsage(
      db,
      "provider-1",
      "hash-1",
      {
        "anthropic-ratelimit-unified-5h-utilization": "0.5",
        "anthropic-ratelimit-unified-7d_oi-utilization": "0.63",
        "anthropic-ratelimit-unified-7d_oi-reset": "1785636000",
      },
      200,
    );

    assert.deepEqual(getUnifiedUsage(db, "provider-1", "hash-1")!.headers, {
      "anthropic-ratelimit-unified-5h-utilization": "0.5",
      "anthropic-ratelimit-unified-7d_oi-utilization": "0.63",
      "anthropic-ratelimit-unified-7d_oi-reset": "1785636000",
    });
  } finally {
    closeDatabase(db);
  }
});

test("provider deletion cascades unified usage snapshots", () => {
  const db = setup();
  try {
    upsertUnifiedUsage(db, "provider-1", "hash-1", { x: "y" }, 200);
    deleteProvider(db, "provider-1");
    assert.equal(getUnifiedUsage(db, "provider-1", "hash-1"), null);
  } finally {
    closeDatabase(db);
  }
});

test("malformed stored JSON degrades to null", () => {
  const db = setup();
  try {
    db.prepare(
      `INSERT INTO provider_key_unified_usage
       (provider_id, key_hash, headers_json, http_status, captured_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("provider-1", "hash-1", "not-json", 200, new Date().toISOString());
    assert.equal(getUnifiedUsage(db, "provider-1", "hash-1"), null);
  } finally {
    closeDatabase(db);
  }
});
