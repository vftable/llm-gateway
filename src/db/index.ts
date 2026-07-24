// SQLite connection + schema migration.
//
// One database file holds every piece of gateway state: providers, models (and
// their per-provider fallback chains), users, gateway API keys, daily usage
// counters, request logs, and a key/value settings table. WAL mode is enabled
// for concurrent reader/writer throughput; foreign keys are ON so deleting a
// model cascades its fallback links and deleting a user nulls-out her keys.

import crypto from "crypto";
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
  disabled_api_keys TEXT NOT NULL DEFAULT '[]',
  auth_scheme       TEXT NOT NULL DEFAULT 'bearer',
  extra_headers     TEXT NOT NULL DEFAULT '{}',
  retry_attempts    INTEGER NOT NULL DEFAULT 1,
  retry_interval_ms INTEGER NOT NULL DEFAULT 3000,
  request_timeout_ms INTEGER NOT NULL DEFAULT 600000,
  tls_verify        INTEGER NOT NULL DEFAULT 1,
  enabled           INTEGER NOT NULL DEFAULT 1,
  format            TEXT,
  endpoints         TEXT NOT NULL DEFAULT '[]',
  endpoint_paths    TEXT NOT NULL DEFAULT '{}',
  native_conversion INTEGER NOT NULL DEFAULT 0,
  catalog_id        TEXT,
  base_path         TEXT NOT NULL DEFAULT '',
  models_path       TEXT NOT NULL DEFAULT '/v1/models',
  proxy             TEXT,
  country           TEXT,
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
  context_window    INTEGER,
  max_output_tokens INTEGER,
  -- A provider may appear more than once in a chain (different upstream models
  -- as successive fallback hops), so identity is (model, provider, upstream).
  UNIQUE(model_id, provider_id, upstream_model)
);
CREATE INDEX IF NOT EXISTS idx_model_providers_model    ON model_providers(model_id);
CREATE INDEX IF NOT EXISTS idx_model_providers_provider ON model_providers(provider_id);

-- Per-provider catalog of imported upstream models. These are NOT exposed on
-- /v1/models; they are the building blocks a user references (by upstream_id)
-- when authoring an exposed model's fallback chain. A chain link may override
-- an imported model's context_window / max_output_tokens for that one hop.
CREATE TABLE IF NOT EXISTS provider_models (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id       TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  upstream_id       TEXT NOT NULL,
  display_name      TEXT,
  context_window    INTEGER,
  max_output_tokens INTEGER,
  capabilities      TEXT,
  transforms        TEXT NOT NULL DEFAULT '[]',
  notes             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(provider_id, upstream_id)
);
CREATE INDEX IF NOT EXISTS idx_provider_models_provider ON provider_models(provider_id);

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
  requests    INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL NOT NULL DEFAULT 0,
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
  upstream_key_hash TEXT,
  upstream_key_mask TEXT,
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
  debug_response TEXT,
  cost_usd       REAL
);
CREATE INDEX IF NOT EXISTS idx_request_logs_ts        ON request_logs(ts);
CREATE INDEX IF NOT EXISTS idx_request_logs_api_key   ON request_logs(api_key_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_model     ON request_logs(model);
CREATE INDEX IF NOT EXISTS idx_request_logs_provider  ON request_logs(provider_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Per upstream-key health, persisted so cooldowns / auth-fails survive restart.
-- Keyed by a hash of the raw key (never store the key itself here).
CREATE TABLE IF NOT EXISTS provider_key_health (
  provider_id        TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  key_hash           TEXT NOT NULL,
  rate_limited_until INTEGER NOT NULL DEFAULT 0,
  auth_failed        INTEGER NOT NULL DEFAULT 0,
  last_error_status  INTEGER,
  last_error         TEXT,
  last_error_at      TEXT,
  -- Lifetime count of 401/403 responses for this key. Auth failures short-
  -- circuit out of the retry loop before a request_logs row is ever written
  -- (see engine.ts forward()), so the key manager's error count sources this
  -- column instead of request_logs for that failure class.
  auth_fail_count    INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (provider_id, key_hash)
);

-- A quota cooldown that applies only to one model CLASS rather than the whole
-- key. Claude Code uses this for the Fable-only 7d_oi subscription window: a
-- key can be unavailable to Fable while still accepting Opus/Sonnet traffic.
CREATE TABLE IF NOT EXISTS provider_key_model_cooldown (
  provider_id       TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  key_hash          TEXT NOT NULL,
  model_class       TEXT NOT NULL,
  cooldown_until    INTEGER NOT NULL DEFAULT 0,
  last_error_status INTEGER,
  last_error        TEXT,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (provider_id, key_hash, model_class)
);

-- Learned (key, model) affinity: which key has served which model, and a
-- rolling failure count used to evict a proven pairing after repeated failures.
CREATE TABLE IF NOT EXISTS key_model_affinity (
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  key_hash    TEXT NOT NULL,
  model       TEXT NOT NULL,
  fails       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider_id, key_hash, model)
);

-- Learned quota/access class for a key. "base" combines Sonnet/Opus/Haiku;
-- "fable" combines Fable/Mythos. It is only a fallback preference when no
-- exact-model sticky/affinity match exists, preserving exact-model cache state.
CREATE TABLE IF NOT EXISTS key_class_affinity (
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  key_hash    TEXT NOT NULL,
  model_class TEXT NOT NULL,
  fails       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider_id, key_hash, model_class)
);

-- The single "sticky" key currently preferred for a (provider, model) pair —
-- the last key that successfully served this model. Selection prefers this
-- exact key over round-robin/affinity-pool picking so repeat requests reuse
-- the same upstream key (better provider-side prompt-cache hit rates, more
-- predictable per-key rate-limit budgeting) instead of spreading evenly
-- across the whole pool. Falls through to the normal pool once the sticky
-- key goes unhealthy (auth-failed/rate-limited) or its affinity is evicted.
CREATE TABLE IF NOT EXISTS key_model_sticky (
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model       TEXT NOT NULL,
  key_hash    TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (provider_id, model)
);

-- Keys whose subscription plan is PROVEN to have long-context usage credits —
-- learned when a key succeeds on a request that OTHER keys rejected with the
-- Claude Code "usage credits are required for long context" 429. Selection
-- gives these keys extra pull in the pool (they float ahead of unproven keys
-- among the fresh candidates) so long-context traffic concentrates on the keys
-- that can actually serve it, instead of wasting rotations on credit-less keys.
-- A key's row is cleared the moment it itself returns that 429 (its plan
-- changed). Provider-wide, not per-model: a plan either has long-context
-- credits or it doesn't.
CREATE TABLE IF NOT EXISTS key_credit_proven (
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  key_hash    TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (provider_id, key_hash)
);

-- Latest Claude Code subscription quota snapshot learned passively from
-- anthropic-ratelimit-unified-* response headers. Never stores raw credentials.
CREATE TABLE IF NOT EXISTS provider_key_unified_usage (
  provider_id  TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  key_hash     TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  http_status  INTEGER,
  captured_at  TEXT NOT NULL,
  PRIMARY KEY (provider_id, key_hash)
);

-- Structured provider API keys. Each key has an id, per-key metadata, and an
-- enabled flag. Replaces the legacy api_keys / disabled_api_keys JSON arrays
-- on the providers table.
CREATE TABLE IF NOT EXISTS provider_keys (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  credential  TEXT NOT NULL,
  cred_hash   TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  metadata    TEXT NOT NULL DEFAULT '{}',
  label       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(provider_id, cred_hash)
);
CREATE INDEX IF NOT EXISTS idx_provider_keys_provider  ON provider_keys(provider_id);
CREATE INDEX IF NOT EXISTS idx_provider_keys_cred_hash ON provider_keys(cred_hash);

-- Per-provider key sync configuration for background polling.
CREATE TABLE IF NOT EXISTS provider_key_sync (
  provider_id       TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
  poll_url          TEXT NOT NULL,
  poll_headers      TEXT NOT NULL DEFAULT '{}',
  poll_interval_sec INTEGER NOT NULL DEFAULT 300,
  last_synced_at    TEXT,
  last_sync_error   TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS model_pricing (
  alias             TEXT PRIMARY KEY,
  prompt_per_1m     REAL,
  completion_per_1m REAL,
  cached_per_1m     REAL,
  updated_at        TEXT NOT NULL
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
  addColumnIfMissing(db, "providers", "catalog_id", "TEXT");
  addColumnIfMissing(db, "providers", "base_path", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(
    db,
    "providers",
    "models_path",
    "TEXT NOT NULL DEFAULT '/v1/models'",
  );
  addColumnIfMissing(db, "providers", "proxy", "TEXT");
  addColumnIfMissing(db, "providers", "country", "TEXT");
  // Per-kind path override (JSON) for non-standard layouts; back-filled below.
  addColumnIfMissing(
    db,
    "providers",
    "endpoint_paths",
    "TEXT NOT NULL DEFAULT '{}'",
  );
  // Convert legacy path-string endpoints (e.g. ["/v1/chat/completions"]) into
  // wire KINDS (["chat"]), back-filling any NON-STANDARD path into endpoint_paths
  // so existing rows keep byte-identical upstream URLs. Idempotent: rows already
  // in kind form are left untouched.
  migrateEndpointsToKinds(db);
  // Keys the operator has toggled OFF: kept aside so key selection skips them
  // (only `api_keys` is rotated) but they aren't lost. Round-trips through the
  // admin API as `disabledApiKeys`.
  addColumnIfMissing(
    db,
    "providers",
    "disabled_api_keys",
    "TEXT NOT NULL DEFAULT '[]'",
  );
  addColumnIfMissing(db, "model_providers", "endpoint", "TEXT");
  // Per-link (per-hop) overrides of the imported model's base limits, so one
  // fallback hop can advertise a smaller context window and be skipped safely.
  addColumnIfMissing(db, "model_providers", "context_window", "INTEGER");
  addColumnIfMissing(db, "model_providers", "max_output_tokens", "INTEGER");
  // Anthropic-style capability listing captured when a rich upstream model is
  // imported (JSON; null when the provider reports none).
  addColumnIfMissing(db, "provider_models", "capabilities", "TEXT");
  // Relax the old UNIQUE(model_id, provider_id) to include upstream_model so a
  // provider can appear multiple times in a chain. SQLite can't ALTER a
  // constraint, so rebuild the table when the old constraint is still present.
  migrateModelProvidersUnique(db);
  // Drop the legacy `format NOT NULL DEFAULT 'openai'` constraint so an
  // adapter-backed provider can store format=NULL (format is now a derived hint).
  // SQLite can't ALTER a constraint, so rebuild the table when it's still present.
  migrateProvidersFormatNullable(db);
  addColumnIfMissing(db, "providers", "provider_config", "TEXT");
  addColumnIfMissing(db, "models", "type", "TEXT NOT NULL DEFAULT 'openai'");
  addColumnIfMissing(db, "request_logs", "client", "TEXT");
  addColumnIfMissing(db, "request_logs", "cached_tokens", "INTEGER");
  addColumnIfMissing(db, "request_logs", "debug_request", "TEXT");
  addColumnIfMissing(db, "request_logs", "debug_response", "TEXT");
  addColumnIfMissing(db, "request_logs", "upstream_key_hash", "TEXT");
  addColumnIfMissing(db, "request_logs", "upstream_key_mask", "TEXT");
  // Per-group request counter. Each usage_breakdown row aggregates many requests
  // for one (key, day, model, provider); without this column COUNT(*) is always
  // 1 (one row per group). Backfilled to 1 for existing rows; rebuild-from-logs
  // recomputes the true counts.
  addColumnIfMissing(db, "provider_key_health", "last_error_status", "INTEGER");
  addColumnIfMissing(db, "provider_key_health", "last_error", "TEXT");
  addColumnIfMissing(
    db,
    "provider_key_health",
    "auth_fail_count",
    "INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing(db, "provider_key_health", "last_error_at", "TEXT");
  addColumnIfMissing(
    db,
    "usage_breakdown",
    "requests",
    "INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing(db, "request_logs", "cost_usd", "REAL");
  addColumnIfMissing(
    db,
    "usage_breakdown",
    "cost_usd",
    "REAL NOT NULL DEFAULT 0",
  );
  // ponytail: CREATE TABLE IF NOT EXISTS covers both fresh-DB (SCHEMA_SQL) and legacy-DB
  db.exec(`CREATE TABLE IF NOT EXISTS model_pricing (
    alias TEXT PRIMARY KEY,
    prompt_per_1m REAL,
    completion_per_1m REAL,
    cached_per_1m REAL,
    updated_at TEXT NOT NULL
  );`);
  migrateProviderKeysToTable(db);
  migrateApiKeysDropFull(db);
}

// Rebuild model_providers when it still carries the legacy
// UNIQUE(model_id, provider_id) constraint, replacing it with
// UNIQUE(model_id, provider_id, upstream_model). No-op once migrated (new DBs
// are created correctly by SCHEMA_SQL).
// Convert a legacy endpoints column (array of path strings) into wire kinds,
// back-filling non-standard paths into endpoint_paths so URLs stay byte-identical.
// Skips rows already in kind form (idempotent).
function migrateEndpointsToKinds(db: DB): void {
  const kindOf = (p: string): "chat" | "messages" | "responses" | null => {
    const x = p.split("?")[0];
    if (x === "chat" || x === "messages" || x === "responses") return x;
    if (x.endsWith("/messages")) return "messages";
    if (x.endsWith("/responses")) return "responses";
    if (x.endsWith("/chat/completions")) return "chat";
    return null;
  };
  const stdPath = (
    kind: "chat" | "messages" | "responses",
    hasBase: boolean,
  ): string => {
    const bare =
      kind === "messages"
        ? "/messages"
        : kind === "responses"
          ? "/responses"
          : "/chat/completions";
    return hasBase ? bare : "/v1" + bare;
  };

  const rows = db
    .prepare("SELECT id, endpoints, endpoint_paths, base_path FROM providers")
    .all() as Array<{
    id: string;
    endpoints: string;
    endpoint_paths: string;
    base_path: string | null;
  }>;

  const update = db.prepare(
    "UPDATE providers SET endpoints=@endpoints, endpoint_paths=@endpoint_paths WHERE id=@id",
  );

  for (const r of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.endpoints);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    // Nothing to do if every entry is already a bare kind.
    const anyPath = parsed.some(
      (e) => typeof e === "string" && e.startsWith("/"),
    );
    if (!anyPath) continue;

    const hasBase = !!(r.base_path && r.base_path.length);
    let overrides: Record<string, string> = {};
    try {
      const existing = JSON.parse(r.endpoint_paths || "{}");
      if (existing && typeof existing === "object" && !Array.isArray(existing))
        overrides = existing as Record<string, string>;
    } catch {
      /* ignore */
    }

    const kinds: string[] = [];
    for (const e of parsed) {
      if (typeof e !== "string") continue;
      const kind = kindOf(e);
      if (!kind) continue;
      if (!kinds.includes(kind)) kinds.push(kind);
      // A path that isn't the standard one for this kind → preserve as override.
      if (e.startsWith("/") && e !== stdPath(kind, hasBase) && !overrides[kind])
        overrides[kind] = e;
    }
    update.run({
      id: r.id,
      endpoints: JSON.stringify(kinds),
      endpoint_paths: JSON.stringify(overrides),
    });
  }
}

function migrateModelProvidersUnique(db: DB): void {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='model_providers'",
    )
    .get() as { sql?: string } | undefined;
  const sql = row?.sql ?? "";
  // Already migrated (or fresh) if the 3-col unique is present.
  if (
    /UNIQUE\s*\(\s*model_id\s*,\s*provider_id\s*,\s*upstream_model\s*\)/i.test(
      sql,
    )
  )
    return;
  if (!/UNIQUE\s*\(\s*model_id\s*,\s*provider_id\s*\)/i.test(sql)) return;

  db.exec("PRAGMA foreign_keys=OFF;");
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE model_providers_new (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id       TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        provider_id    TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        upstream_model TEXT NOT NULL,
        priority       INTEGER NOT NULL DEFAULT 0,
        enabled        INTEGER NOT NULL DEFAULT 1,
        endpoint       TEXT,
        context_window    INTEGER,
        max_output_tokens INTEGER,
        UNIQUE(model_id, provider_id, upstream_model)
      );
      INSERT INTO model_providers_new
        (id, model_id, provider_id, upstream_model, priority, enabled, endpoint,
         context_window, max_output_tokens)
        SELECT id, model_id, provider_id, upstream_model, priority, enabled,
         endpoint, context_window, max_output_tokens FROM model_providers;
      DROP TABLE model_providers;
      ALTER TABLE model_providers_new RENAME TO model_providers;
      CREATE INDEX IF NOT EXISTS idx_model_providers_model    ON model_providers(model_id);
      CREATE INDEX IF NOT EXISTS idx_model_providers_provider ON model_providers(provider_id);
    `);
  });
  tx();
  db.exec("PRAGMA foreign_keys=ON;");
}

// Rebuild `providers` to make `format` nullable when a legacy DB still has the
// old `format ... NOT NULL` (with a DEFAULT 'openai'). No-op on fresh DBs (whose
// format column is already nullable) and once rebuilt. Child tables reference
// providers by id, which is preserved, so foreign_keys=OFF during the swap keeps
// them intact. Runs AFTER the additive column migrations so every column exists.
function migrateProvidersFormatNullable(db: DB): void {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='providers'",
    )
    .get() as { sql?: string } | undefined;
  const sql = row?.sql ?? "";
  // The legacy column is `format TEXT NOT NULL DEFAULT 'openai'`. If `format` is
  // not declared NOT NULL, there's nothing to do.
  if (!/\bformat\b[^,]*\bNOT\s+NULL/i.test(sql)) return;

  // Copy only the columns that exist in BOTH the old table and the rebuilt one,
  // so the migration is resilient to partially-patched DBs (any column the old
  // table lacks takes the new schema's DEFAULT).
  const oldCols = new Set(
    (
      db.prepare("PRAGMA table_info(providers)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name),
  );

  db.exec("PRAGMA foreign_keys=OFF;");
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE providers_new (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        base_url          TEXT NOT NULL,
        host              TEXT,
        api_keys          TEXT NOT NULL DEFAULT '[]',
        disabled_api_keys TEXT NOT NULL DEFAULT '[]',
        auth_scheme       TEXT NOT NULL DEFAULT 'bearer',
        extra_headers     TEXT NOT NULL DEFAULT '{}',
        retry_attempts    INTEGER NOT NULL DEFAULT 1,
        retry_interval_ms INTEGER NOT NULL DEFAULT 3000,
        request_timeout_ms INTEGER NOT NULL DEFAULT 600000,
        tls_verify        INTEGER NOT NULL DEFAULT 1,
        enabled           INTEGER NOT NULL DEFAULT 1,
        format            TEXT,
        endpoints         TEXT NOT NULL DEFAULT '[]',
        endpoint_paths    TEXT NOT NULL DEFAULT '{}',
        native_conversion INTEGER NOT NULL DEFAULT 0,
        catalog_id        TEXT,
        base_path         TEXT NOT NULL DEFAULT '',
        models_path       TEXT NOT NULL DEFAULT '/v1/models',
        proxy             TEXT,
        country           TEXT,
        sort_order        INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );
    `);
    const newCols = (
      db.prepare("PRAGMA table_info(providers_new)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    const shared = newCols.filter((c) => oldCols.has(c));
    const cols = shared.join(", ");
    db.exec(
      `INSERT INTO providers_new (${cols}) SELECT ${cols} FROM providers;
       DROP TABLE providers;
       ALTER TABLE providers_new RENAME TO providers;`,
    );
  });
  tx();
  db.exec("PRAGMA foreign_keys=ON;");
}

// Migrate legacy api_keys / disabled_api_keys JSON arrays on the providers
// table into the new provider_keys table. Idempotent: skips providers that
// already have rows in provider_keys.
function migrateProviderKeysToTable(db: DB): void {
  const hasTable =
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='provider_keys'",
        )
        .get() as { n: number }
    ).n > 0;
  if (!hasTable) return;

  const hasKeys = db
    .prepare("SELECT COUNT(*) AS n FROM provider_keys")
    .get() as { n: number };
  if (hasKeys.n > 0) return;

  const rows = db
    .prepare("SELECT id, api_keys, disabled_api_keys FROM providers")
    .all() as Array<{
    id: string;
    api_keys: string;
    disabled_api_keys: string | null;
  }>;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO provider_keys
       (id, provider_id, credential, cred_hash, enabled, metadata, label, created_at, updated_at)
     VALUES (@id, @provider_id, @credential, @cred_hash, @enabled, '{}', NULL, @now, @now)`,
  );

  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    for (const r of rows) {
      let enabled: string[] = [];
      let disabled: string[] = [];
      try {
        enabled = JSON.parse(r.api_keys || "[]");
      } catch {
        /* ignore corrupt JSON */
      }
      try {
        disabled = JSON.parse(r.disabled_api_keys || "[]");
      } catch {
        /* ignore */
      }
      for (const key of enabled) {
        if (!key || typeof key !== "string") continue;
        insert.run({
          id: crypto.randomBytes(4).toString("hex"),
          provider_id: r.id,
          credential: key,
          cred_hash: crypto
            .createHash("sha256")
            .update(key)
            .digest("hex")
            .slice(0, 32),
          enabled: 1,
          now,
        });
      }
      for (const key of disabled) {
        if (!key || typeof key !== "string") continue;
        insert.run({
          id: crypto.randomBytes(4).toString("hex"),
          provider_id: r.id,
          credential: key,
          cred_hash: crypto
            .createHash("sha256")
            .update(key)
            .digest("hex")
            .slice(0, 32),
          enabled: 0,
          now,
        });
      }
    }
  });
  tx();
}

// Drop the plaintext key_full column from api_keys. The full key is only
// returned in-memory on creation, never needs to be re-read from the DB.
function migrateApiKeysDropFull(db: DB): void {
  if (!hasColumn(db, "api_keys", "key_full")) return;

  db.exec("PRAGMA foreign_keys=OFF;");
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE api_keys_new (
        id             TEXT PRIMARY KEY,
        name           TEXT,
        key_prefix     TEXT NOT NULL,
        key_hash       TEXT NOT NULL UNIQUE,
        user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
        tokens_per_day INTEGER,
        enabled        INTEGER NOT NULL DEFAULT 1,
        last_used_at   TEXT,
        created_at     TEXT NOT NULL
      );
      INSERT INTO api_keys_new
        (id, name, key_prefix, key_hash, user_id, tokens_per_day, enabled, last_used_at, created_at)
        SELECT id, name, key_prefix, key_hash, user_id, tokens_per_day, enabled, last_used_at, created_at
        FROM api_keys;
      DROP TABLE api_keys;
      ALTER TABLE api_keys_new RENAME TO api_keys;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
      CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
    `);
  });
  tx();
  db.exec("PRAGMA foreign_keys=ON;");
}
