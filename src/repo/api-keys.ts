// Gateway API-key repository.
//
// Gateway keys are the credentials *clients* present to this gateway. We store
// a SHA-256 hash for O(1) auth lookup and a short prefix for display. The full
// key is returned in-memory from create() so the UI can show it once; it is
// never persisted or re-readable from the DB.

import crypto from "crypto";
import type { Database as DB } from "better-sqlite3";
import type { ApiKey } from "../types";
import { sha256 } from "../config";
import { slugify } from "./providers";

export const KEY_PREFIX = "sk-";

// Alphabet for generated key payloads.
const KEY_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const KEY_PAYLOAD_LENGTH = 24;

interface ApiKeyRow {
  id: string;
  name: string | null;
  key_prefix: string;
  key_hash: string;
  user_id: string | null;
  tokens_per_day: number | null;
  enabled: number;
  last_used_at: string | null;
  created_at: string;
  user_name: string | null;
}

const SELECT_JOIN =
  "SELECT k.*, u.name AS user_name FROM api_keys k " +
  "LEFT JOIN users u ON u.id = k.user_id";

function mapKey(r: ApiKeyRow): ApiKey {
  return {
    id: r.id,
    name: r.name,
    keyPrefix: r.key_prefix,
    userId: r.user_id,
    userName: r.user_name,
    tokensPerDay: r.tokens_per_day,
    enabled: !!r.enabled,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
  };
}

// Generate "sk-" + 24 alphanumeric chars, sampled uniformly (rejection
// sampling avoids modulo bias). ~143 bits of entropy.
export function generateKey(): string {
  let payload = "";
  while (payload.length < KEY_PAYLOAD_LENGTH) {
    for (const byte of crypto.randomBytes(KEY_PAYLOAD_LENGTH)) {
      if (byte < KEY_ALPHABET.length * 4) {
        payload += KEY_ALPHABET[byte % KEY_ALPHABET.length];
        if (payload.length === KEY_PAYLOAD_LENGTH) break;
      }
    }
  }
  return KEY_PREFIX + payload;
}

// Human-friendly masked form, e.g. "sk-bHP7x3S…MNqP".
export function maskKey(full: string): string {
  if (full.length <= 12) return full;
  return `${full.slice(0, 10)}…${full.slice(-4)}`;
}

// Cheap existence check used by the per-request auth middleware.
export function countEnabledApiKeys(db: DB): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE enabled = 1")
    .get() as { n: number };
  return row.n;
}

export function listApiKeys(db: DB): ApiKey[] {
  const rows = db
    .prepare(`${SELECT_JOIN} ORDER BY k.created_at DESC`)
    .all() as ApiKeyRow[];
  return rows.map(mapKey);
}

export function getApiKey(db: DB, id: string): ApiKey | null {
  const row = db.prepare(`${SELECT_JOIN} WHERE k.id = ?`).get(id) as
    ApiKeyRow | undefined;
  return row ? mapKey(row) : null;
}

// Auth lookup: find an enabled key by the hash of the presented secret.
export function getApiKeyByHash(db: DB, hash: string): ApiKey | null {
  const row = db
    .prepare(`${SELECT_JOIN} WHERE k.key_hash = ? AND k.enabled = 1`)
    .get(hash) as ApiKeyRow | undefined;
  return row ? mapKey(row) : null;
}

export interface ApiKeyInput {
  id?: string;
  name?: string | null;
  userId?: string | null;
  tokensPerDay?: number | null;
  enabled?: boolean;
}

// Create a key. If `key` is omitted, a fresh random one is generated. Returns
// the ApiKey with `keyFull` populated so the caller can show it once.
export function createApiKey(
  db: DB,
  input: ApiKeyInput,
  key?: string,
): ApiKey & { keyFull: string } {
  const now = new Date().toISOString();
  const full = key && key.length ? key : generateKey();
  const id =
    input.id ||
    (input.name ? slugify(input.name) : "") ||
    `key-${crypto.randomBytes(6).toString("hex")}`;
  if (getApiKey(db, id)) throw new Error(`API key '${id}' already exists`);

  db.prepare(
    `INSERT INTO api_keys
      (id, name, key_prefix, key_hash, user_id, tokens_per_day, enabled, last_used_at, created_at)
     VALUES (@id, @name, @key_prefix, @key_hash, @user_id, @tokens_per_day, @enabled, @last_used_at, @created_at)`,
  ).run({
    id,
    name: input.name ?? null,
    key_prefix: maskKey(full),
    key_hash: sha256(full),
    user_id: input.userId ?? null,
    tokens_per_day:
      input.tokensPerDay !== undefined && input.tokensPerDay !== null
        ? input.tokensPerDay
        : null,
    enabled: input.enabled === false ? 0 : 1,
    last_used_at: null,
    created_at: now,
  });
  return { ...getApiKey(db, id)!, keyFull: full };
}

export function updateApiKey(
  db: DB,
  id: string,
  input: Partial<ApiKeyInput>,
): ApiKey | null {
  const existing = getApiKey(db, id);
  if (!existing) return null;
  db.prepare(
    `UPDATE api_keys SET
       name=@name, user_id=@user_id, tokens_per_day=@tokens_per_day, enabled=@enabled
     WHERE id=@id`,
  ).run({
    id,
    name: input.name !== undefined ? input.name : existing.name,
    user_id: input.userId !== undefined ? input.userId : existing.userId,
    tokens_per_day:
      input.tokensPerDay !== undefined
        ? input.tokensPerDay === null
          ? null
          : input.tokensPerDay
        : existing.tokensPerDay,
    enabled:
      input.enabled !== undefined
        ? input.enabled
          ? 1
          : 0
        : existing.enabled
          ? 1
          : 0,
  });
  return getApiKey(db, id);
}

export function deleteApiKey(db: DB, id: string): boolean {
  const r = db.prepare("DELETE FROM api_keys WHERE id = ?").run(id);
  return r.changes > 0;
}

export function touchLastUsed(db: DB, id: string): void {
  db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id,
  );
}
