// SQLite connection + schema migration.
//
// One database file holds every piece of gateway state: providers, models (and
// their per-provider fallback chains), users, gateway API keys, daily usage
// counters, request logs, and a key/value settings table. WAL mode is enabled
// for concurrent reader/writer throughput; foreign keys are ON so deleting a
// model cascades its fallback links and deleting a user nulls-out her keys.

import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import fs from "fs";
import path from "path";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS providers (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  base_url          TEXT NOT NULL,
  host              TEXT,
  api_keys          TEXT NOT NULL DEFAULT '[]',
  auth_scheme       TEXT NOT NULL DEFAULT 'bearer',
  extra_headers     TEXT NOT NULL DEFAULT '{}',
  retry_attempts    INTEGER NOT NULL DEFAULT 1,
  retry_interval_ms INTEGER NOT NULL DEFAULT 3000,
  request_timeout_ms INTEGER NOT NULL DEFAULT 600000,
  tls_verify        INTEGER NOT NULL DEFAULT 1,
  enabled           INTEGER NOT NULL DEFAULT 1,
  format            TEXT NOT NULL DEFAULT 'openai',
  endpoints         TEXT NOT NULL DEFAULT '[]',
  native_conversion INTEGER NOT NULL DEFAULT 0,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id                TEXT PRIMARY KEY,
  alias             TEXT NOT NULL UNIQUE,
  display_name      TEXT,
  context_window    INTEGER,
  max_output_tokens INTEGER,
  enabled           INTEGER NOT NULL DEFAULT 1,
  responses_native  INTEGER NOT NULL DEFAULT 0,
  type              TEXT NOT NULL DEFAULT 'openai',
  capabilities      TEXT NOT NULL DEFAULT '{}',
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_providers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id       TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  provider_id    TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  upstream_model TEXT NOT NULL,
  priority       INTEGER NOT NULL DEFAULT 0,
  enabled        INTEGER NOT NULL DEFAULT 1,
  endpoint       TEXT,
  UNIQUE(model_id, provider_id)
);
CREATE INDEX IF NOT EXISTS idx_model_providers_model    ON model_providers(model_id);
CREATE INDEX IF NOT EXISTS idx_model_providers_provider ON model_providers(provider_id);

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  notes      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id             TEXT PRIMARY KEY,
  name           TEXT,
  key_prefix     TEXT NOT NULL,
  key_hash       TEXT NOT NULL UNIQUE,
  key_full       TEXT NOT NULL,
  user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  tokens_per_day INTEGER,
  enabled        INTEGER NOT NULL DEFAULT 1,
  last_used_at   TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash  ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_user  ON api_keys(user_id);

CREATE TABLE IF NOT EXISTS usage (
  api_key_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  tokens     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (api_key_id, day)
);

-- Per (key, day, model, provider) token totals. Powers the dashboard's
-- "what did this key resolve to" view — e.g. a key using gpt-5.5 shows the
-- token count and the provider it resolved to (after fallback).
CREATE TABLE IF NOT EXISTS usage_breakdown (
  api_key_id  TEXT NOT NULL,
  day         TEXT NOT NULL,
  model       TEXT NOT NULL,
  provider_id TEXT,
  tokens      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (api_key_id, day, model, provider_id)
);
CREATE INDEX IF NOT EXISTS idx_usage_breakdown_key   ON usage_breakdown(api_key_id);
CREATE INDEX IF NOT EXISTS idx_usage_breakdown_model ON usage_breakdown(model);

CREATE TABLE IF NOT EXISTS request_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  api_key_id    TEXT,
  api_key_name  TEXT,
  user_id       TEXT,
  model         TEXT,
  provider_id   TEXT,
  provider_name TEXT,
  upstream_model TEXT,
  status        INTEGER,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  latency_ms    INTEGER,
  client        TEXT,
  path          TEXT,
  stream        INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  debug_request  TEXT,
  debug_response TEXT
);
CREATE INDEX IF NOT EXISTS idx_request_logs_ts        ON request_logs(ts);
CREATE INDEX IF NOT EXISTS idx_request_logs_api_key   ON request_logs(api_key_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_model     ON request_logs(model);
CREATE INDEX IF NOT EXISTS idx_request_logs_provider  ON request_logs(provider_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

export function openDatabase(dbPath: string): DB {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  // WAL: multiple readers + one writer, much better for a live gateway with a
  // dashboard hitting it at the same time.
  db.pragma("journal_mode = WAL");
  // NORMAL is the recommended durability level with WAL: fsync at checkpoint
  // instead of every commit. A power cut can lose the last few commits but can
  // never corrupt the database.
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  // Cap the -wal file: after a checkpoint it is truncated back under 16MB
  // instead of being left at its high-water mark.
  db.pragma("journal_size_limit = 16777216");

  // Incremental auto-vacuum lets the periodic log prune actually return freed
  // pages to the OS (see vacuumFreePages). Switching it on for a DB created
  // without it requires a one-time VACUUM.
  const av = db.pragma("auto_vacuum", { simple: true }) as number;
  if (av !== 2) {
    db.pragma("auto_vacuum = INCREMENTAL");
    db.exec("VACUUM");
  }

  db.exec(SCHEMA_SQL);
  migrate(db);
  return db;
}

// Return freed pages to the OS after bulk deletes (e.g. request-log pruning).
// Incremental (bounded batches) so it never blocks writers for long.
export function vacuumFreePages(db: DB, maxPages = 2048): void {
  db.pragma(`incremental_vacuum(${maxPages})`);
}

// Flush the WAL into the main file, let SQLite apply its accumulated query-
// planner statistics, and close. Safe to call more than once.
export function closeDatabase(db: DB): void {
  if (!db.open) return;
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    /* checkpoint is best-effort */
  }
  try {
    db.pragma("optimize");
  } catch {
    /* optimize is best-effort */
  }
  db.close();
}

// Additive column migrations for DBs created before the column existed.
// SQLite's ALTER TABLE ADD COLUMN is idempotent-safe via this hasColumn check.
function hasColumn(db: DB, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.some((r) => r.name === column);
}

function addColumnIfMissing(
  db: DB,
  table: string,
  column: string,
  def: string,
): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def};`);
  }
}

function migrate(db: DB): void {
  addColumnIfMissing(
    db,
    "providers",
    "format",
    "TEXT NOT NULL DEFAULT 'openai'",
  );
  addColumnIfMissing(
    db,
    "providers",
    "endpoints",
    "TEXT NOT NULL DEFAULT '[]'",
  );
  addColumnIfMissing(
    db,
    "providers",
    "native_conversion",
    "INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing(db, "model_providers", "endpoint", "TEXT");
  addColumnIfMissing(db, "models", "type", "TEXT NOT NULL DEFAULT 'openai'");
  addColumnIfMissing(db, "request_logs", "client", "TEXT");
  addColumnIfMissing(db, "request_logs", "cached_tokens", "INTEGER");
  addColumnIfMissing(db, "request_logs", "debug_request", "TEXT");
  addColumnIfMissing(db, "request_logs", "debug_response", "TEXT");
}
