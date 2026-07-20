// Structured provider API keys repository.
//
// Each upstream API key gets a stable id, per-key metadata, label, and
// enabled/disabled state. Replaces the legacy string-array storage on the
// providers table. The cred_hash column uses the same SHA-256 prefix as
// KeyHealthStore, so existing health/affinity data carries over seamlessly.

import { randomBytes, createHash } from "crypto";
import type { Database as DB } from "better-sqlite3";
import { parseJsonObject } from "./json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProviderKeyRow {
  id: string;
  provider_id: string;
  credential: string;
  cred_hash: string;
  enabled: number;
  metadata: string;
  label: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderKey {
  id: string;
  providerId: string;
  credential: string;
  credHash: string;
  enabled: boolean;
  metadata: Record<string, string>;
  label: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderKeyInput {
  credential: string;
  enabled?: boolean;
  metadata?: Record<string, string>;
  label?: string | null;
}

export interface BatchKeyOps {
  add?: ProviderKeyInput[];
  remove?: string[];
  update?: Array<{
    id: string;
    enabled?: boolean;
    metadata?: Record<string, string>;
    label?: string | null;
  }>;
  enable?: string[];
  disable?: string[];
}

export interface BatchKeyResult {
  added: number;
  removed: number;
  updated: number;
  enabled: number;
  disabled: number;
  duplicatesSkipped: number;
  errors: Array<{ op: string; detail: string }>;
  keys: ProviderKey[];
}

export interface KeyCount {
  enabled: number;
  disabled: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function credHash(credential: string): string {
  return createHash("sha256").update(credential).digest("hex").slice(0, 32);
}

function genId(): string {
  return randomBytes(4).toString("hex");
}

function mapKey(r: ProviderKeyRow): ProviderKey {
  return {
    id: r.id,
    providerId: r.provider_id,
    credential: r.credential,
    credHash: r.cred_hash,
    enabled: !!r.enabled,
    metadata: parseJsonObject<Record<string, string>>(r.metadata, {}),
    label: r.label,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function listProviderKeys(db: DB, providerId: string): ProviderKey[] {
  const rows = db
    .prepare(
      "SELECT * FROM provider_keys WHERE provider_id = ? ORDER BY created_at",
    )
    .all(providerId) as ProviderKeyRow[];
  return rows.map(mapKey);
}

export function listEnabledCredentials(db: DB, providerId: string): string[] {
  const rows = db
    .prepare(
      "SELECT credential FROM provider_keys WHERE provider_id = ? AND enabled = 1 ORDER BY created_at",
    )
    .all(providerId) as Array<{ credential: string }>;
  return rows.map((r) => r.credential);
}

export function getProviderKey(db: DB, id: string): ProviderKey | null {
  const row = db.prepare("SELECT * FROM provider_keys WHERE id = ?").get(id) as
    ProviderKeyRow | undefined;
  return row ? mapKey(row) : null;
}

export function getProviderKeyByHash(
  db: DB,
  providerId: string,
  hash: string,
): ProviderKey | null {
  const row = db
    .prepare(
      "SELECT * FROM provider_keys WHERE provider_id = ? AND cred_hash = ?",
    )
    .get(providerId, hash) as ProviderKeyRow | undefined;
  return row ? mapKey(row) : null;
}

export function countProviderKeys(db: DB, providerId: string): KeyCount {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled,
         SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END) AS disabled
       FROM provider_keys WHERE provider_id = ?`,
    )
    .get(providerId) as { total: number; enabled: number; disabled: number };
  return {
    total: row.total,
    enabled: row.enabled ?? 0,
    disabled: row.disabled ?? 0,
  };
}

export function createProviderKey(
  db: DB,
  providerId: string,
  input: ProviderKeyInput,
): ProviderKey {
  const now = new Date().toISOString();
  const hash = credHash(input.credential);
  const id = genId();
  db.prepare(
    `INSERT INTO provider_keys
       (id, provider_id, credential, cred_hash, enabled, metadata, label, created_at, updated_at)
     VALUES (@id, @provider_id, @credential, @cred_hash, @enabled, @metadata, @label, @now, @now)`,
  ).run({
    id,
    provider_id: providerId,
    credential: input.credential,
    cred_hash: hash,
    enabled: input.enabled === false ? 0 : 1,
    metadata: JSON.stringify(input.metadata ?? {}),
    label: input.label ?? null,
    now,
  });
  return getProviderKey(db, id)!;
}

export function updateProviderKey(
  db: DB,
  id: string,
  patch: Partial<Omit<ProviderKeyInput, "credential">>,
): ProviderKey | null {
  const existing = getProviderKey(db, id);
  if (!existing) return null;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE provider_keys SET
       enabled = @enabled,
       metadata = @metadata,
       label = @label,
       updated_at = @now
     WHERE id = @id`,
  ).run({
    id,
    enabled:
      patch.enabled !== undefined
        ? patch.enabled
          ? 1
          : 0
        : existing.enabled
          ? 1
          : 0,
    metadata:
      patch.metadata !== undefined
        ? JSON.stringify(patch.metadata)
        : JSON.stringify(existing.metadata),
    label: patch.label !== undefined ? (patch.label ?? null) : existing.label,
    now,
  });
  return getProviderKey(db, id);
}

export function deleteProviderKey(db: DB, id: string): boolean {
  return (
    db.prepare("DELETE FROM provider_keys WHERE id = ?").run(id).changes > 0
  );
}

export function deleteProviderKeysByProvider(
  db: DB,
  providerId: string,
): number {
  return db
    .prepare("DELETE FROM provider_keys WHERE provider_id = ?")
    .run(providerId).changes;
}

// ---------------------------------------------------------------------------
// Batch operations (atomic)
// ---------------------------------------------------------------------------

export function batchProviderKeys(
  db: DB,
  providerId: string,
  ops: BatchKeyOps,
): BatchKeyResult {
  const result: BatchKeyResult = {
    added: 0,
    removed: 0,
    updated: 0,
    enabled: 0,
    disabled: 0,
    duplicatesSkipped: 0,
    errors: [],
    keys: [],
  };

  const now = new Date().toISOString();

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO provider_keys
       (id, provider_id, credential, cred_hash, enabled, metadata, label, created_at, updated_at)
     VALUES (@id, @provider_id, @credential, @cred_hash, @enabled, @metadata, @label, @now, @now)`,
  );
  const deleteStmt = db.prepare(
    "DELETE FROM provider_keys WHERE id = ? AND provider_id = ?",
  );
  const enableStmt = db.prepare(
    "UPDATE provider_keys SET enabled = 1, updated_at = ? WHERE id = ? AND provider_id = ?",
  );
  const disableStmt = db.prepare(
    "UPDATE provider_keys SET enabled = 0, updated_at = ? WHERE id = ? AND provider_id = ?",
  );
  const updateStmt = db.prepare(
    `UPDATE provider_keys SET
       enabled = @enabled, metadata = @metadata, label = @label, updated_at = @now
     WHERE id = @id AND provider_id = @provider_id`,
  );

  const tx = db.transaction(() => {
    // 1. Add
    if (ops.add) {
      for (const input of ops.add) {
        if (!input.credential) {
          result.errors.push({ op: "add", detail: "empty credential" });
          continue;
        }
        const hash = credHash(input.credential);
        const existing = getProviderKeyByHash(db, providerId, hash);
        if (existing) {
          result.duplicatesSkipped++;
          continue;
        }
        const r = insertStmt.run({
          id: genId(),
          provider_id: providerId,
          credential: input.credential,
          cred_hash: hash,
          enabled: input.enabled === false ? 0 : 1,
          metadata: JSON.stringify(input.metadata ?? {}),
          label: input.label ?? null,
          now,
        });
        if (r.changes > 0) result.added++;
        else result.duplicatesSkipped++;
      }
    }

    // 2. Update
    if (ops.update) {
      for (const u of ops.update) {
        const existing = getProviderKey(db, u.id);
        if (!existing || existing.providerId !== providerId) {
          result.errors.push({ op: "update", detail: `key ${u.id} not found` });
          continue;
        }
        updateStmt.run({
          id: u.id,
          provider_id: providerId,
          enabled:
            u.enabled !== undefined
              ? u.enabled
                ? 1
                : 0
              : existing.enabled
                ? 1
                : 0,
          metadata:
            u.metadata !== undefined
              ? JSON.stringify(u.metadata)
              : JSON.stringify(existing.metadata),
          label: u.label !== undefined ? (u.label ?? null) : existing.label,
          now,
        });
        result.updated++;
      }
    }

    // 3. Enable
    if (ops.enable) {
      for (const keyId of ops.enable) {
        const r = enableStmt.run(now, keyId, providerId);
        if (r.changes > 0) result.enabled++;
      }
    }

    // 4. Disable
    if (ops.disable) {
      for (const keyId of ops.disable) {
        const r = disableStmt.run(now, keyId, providerId);
        if (r.changes > 0) result.disabled++;
      }
    }

    // 5. Remove
    if (ops.remove) {
      for (const keyId of ops.remove) {
        const r = deleteStmt.run(keyId, providerId);
        if (r.changes > 0) result.removed++;
      }
    }
  });

  tx();
  result.keys = listProviderKeys(db, providerId);
  return result;
}

// ---------------------------------------------------------------------------
// Sync repo (poll config persistence)
// ---------------------------------------------------------------------------

export interface ProviderKeySyncConfig {
  providerId: string;
  pollUrl: string;
  pollHeaders: Record<string, string>;
  pollIntervalSec: number;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  enabled: boolean;
}

interface SyncRow {
  provider_id: string;
  poll_url: string;
  poll_headers: string;
  poll_interval_sec: number;
  last_synced_at: string | null;
  last_sync_error: string | null;
  enabled: number;
}

function mapSync(r: SyncRow): ProviderKeySyncConfig {
  return {
    providerId: r.provider_id,
    pollUrl: r.poll_url,
    pollHeaders: parseJsonObject<Record<string, string>>(r.poll_headers, {}),
    pollIntervalSec: r.poll_interval_sec,
    lastSyncedAt: r.last_synced_at,
    lastSyncError: r.last_sync_error,
    enabled: !!r.enabled,
  };
}

export function getKeySyncConfig(
  db: DB,
  providerId: string,
): ProviderKeySyncConfig | null {
  const row = db
    .prepare("SELECT * FROM provider_key_sync WHERE provider_id = ?")
    .get(providerId) as SyncRow | undefined;
  return row ? mapSync(row) : null;
}

export function listKeySyncConfigs(db: DB): ProviderKeySyncConfig[] {
  const rows = db
    .prepare("SELECT * FROM provider_key_sync WHERE enabled = 1")
    .all() as SyncRow[];
  return rows.map(mapSync);
}

export function upsertKeySyncConfig(
  db: DB,
  providerId: string,
  input: {
    pollUrl: string;
    pollHeaders?: Record<string, string>;
    pollIntervalSec?: number;
    enabled?: boolean;
  },
): ProviderKeySyncConfig {
  db.prepare(
    `INSERT INTO provider_key_sync
       (provider_id, poll_url, poll_headers, poll_interval_sec, enabled)
     VALUES (@provider_id, @poll_url, @poll_headers, @poll_interval_sec, @enabled)
     ON CONFLICT(provider_id) DO UPDATE SET
       poll_url = @poll_url,
       poll_headers = @poll_headers,
       poll_interval_sec = @poll_interval_sec,
       enabled = @enabled`,
  ).run({
    provider_id: providerId,
    poll_url: input.pollUrl,
    poll_headers: JSON.stringify(input.pollHeaders ?? {}),
    poll_interval_sec: Math.max(30, input.pollIntervalSec ?? 300),
    enabled: input.enabled === false ? 0 : 1,
  });
  return getKeySyncConfig(db, providerId)!;
}

export function updateSyncStatus(
  db: DB,
  providerId: string,
  lastSyncedAt: string,
  lastSyncError: string | null,
): void {
  db.prepare(
    "UPDATE provider_key_sync SET last_synced_at = ?, last_sync_error = ? WHERE provider_id = ?",
  ).run(lastSyncedAt, lastSyncError, providerId);
}

export function deleteKeySyncConfig(db: DB, providerId: string): boolean {
  return (
    db
      .prepare("DELETE FROM provider_key_sync WHERE provider_id = ?")
      .run(providerId).changes > 0
  );
}
