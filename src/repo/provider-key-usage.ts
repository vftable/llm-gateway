import type { Database as DB } from "better-sqlite3";
import { parseJsonObject } from "./json";

export interface UnifiedUsageSnapshot {
  providerId: string;
  keyHash: string;
  headers: Record<string, string>;
  httpStatus: number | null;
  capturedAt: string;
}

interface UsageRow {
  provider_id: string;
  key_hash: string;
  headers_json: string;
  http_status: number | null;
  captured_at: string;
}

function mapSnapshot(row: UsageRow): UnifiedUsageSnapshot | null {
  const headers = parseJsonObject<Record<string, string> | null>(
    row.headers_json,
    null,
  );
  if (!headers) return null;
  return {
    providerId: row.provider_id,
    keyHash: row.key_hash,
    headers,
    httpStatus: row.http_status,
    capturedAt: row.captured_at,
  };
}

export function upsertUnifiedUsage(
  db: DB,
  providerId: string,
  keyHash: string,
  headers: Record<string, string>,
  httpStatus: number | null,
  capturedAt = new Date().toISOString(),
): UnifiedUsageSnapshot {
  const has7dOi = Object.keys(headers).some((key) =>
    key.startsWith("anthropic-ratelimit-unified-7d_oi-"),
  );
  const stored =
    httpStatus !== null && httpStatus >= 200 && httpStatus < 300 && !has7dOi
      ? getUnifiedUsage(db, providerId, keyHash)
      : null;
  const mergedHeaders = stored
    ? {
        ...Object.fromEntries(
          Object.entries(stored.headers).filter(([key]) =>
            key.startsWith("anthropic-ratelimit-unified-7d_oi-"),
          ),
        ),
        ...headers,
      }
    : headers;

  db.prepare(
    `INSERT INTO provider_key_unified_usage
       (provider_id, key_hash, headers_json, http_status, captured_at)
     VALUES (@provider_id, @key_hash, @headers_json, @http_status, @captured_at)
     ON CONFLICT(provider_id, key_hash) DO UPDATE SET
       headers_json = excluded.headers_json,
       http_status = excluded.http_status,
       captured_at = excluded.captured_at`,
  ).run({
    provider_id: providerId,
    key_hash: keyHash,
    headers_json: JSON.stringify(mergedHeaders),
    http_status: httpStatus,
    captured_at: capturedAt,
  });
  return getUnifiedUsage(db, providerId, keyHash)!;
}

export function getUnifiedUsage(
  db: DB,
  providerId: string,
  keyHash: string,
): UnifiedUsageSnapshot | null {
  const row = db
    .prepare(
      `SELECT provider_id, key_hash, headers_json, http_status, captured_at
       FROM provider_key_unified_usage
       WHERE provider_id = ? AND key_hash = ?`,
    )
    .get(providerId, keyHash) as UsageRow | undefined;
  return row ? mapSnapshot(row) : null;
}

export function clearAllUnifiedUsage(db: DB): number {
  return db.prepare("DELETE FROM provider_key_unified_usage").run().changes;
}

export function hasUnifiedUsage(
  db: DB,
  providerId: string,
  keyHash: string,
): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM provider_key_unified_usage
       WHERE provider_id = ? AND key_hash = ?`,
    )
    .get(providerId, keyHash);
}
