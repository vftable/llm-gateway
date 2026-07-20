// Key import service: fetches keys from a URL, parses multiple formats,
// and feeds them through batchProviderKeys for atomic upsert.

import type { Database as DB } from "better-sqlite3";
import type { ProviderKeyInput, BatchKeyResult } from "../repo/provider-keys";
import { batchProviderKeys, listProviderKeys } from "../repo/provider-keys";

export interface ImportResult {
  batch: BatchKeyResult;
  fetched: number;
  mode: "append" | "replace";
}

// Accepted remote response formats (auto-detected):
// 1. JSON string array: ["sk-key1", "sk-key2"]
// 2. JSON object array: [{ "credential": "sk-key1", "metadata": {...}, "label": "..." }]
// 3. Newline-delimited text: one key per line
export function parseKeysFromResponse(
  text: string,
  defaultMetadata?: Record<string, string>,
): ProviderKeyInput[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Try JSON first
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as unknown[];
      return arr
        .map((item): ProviderKeyInput | null => {
          if (typeof item === "string") {
            const cred = item.trim();
            return cred
              ? { credential: cred, metadata: defaultMetadata }
              : null;
          }
          if (item && typeof item === "object") {
            const obj = item as Record<string, unknown>;
            const credential =
              typeof obj.credential === "string"
                ? obj.credential.trim()
                : typeof obj.key === "string"
                  ? obj.key.trim()
                  : null;
            if (!credential) return null;
            const metadata: Record<string, string> = {
              ...(defaultMetadata ?? {}),
            };
            if (obj.metadata && typeof obj.metadata === "object") {
              for (const [k, v] of Object.entries(
                obj.metadata as Record<string, unknown>,
              )) {
                if (typeof v === "string") metadata[k] = v;
              }
            }
            return {
              credential,
              enabled: obj.enabled === undefined ? undefined : !!obj.enabled,
              metadata: Object.keys(metadata).length ? metadata : undefined,
              label: typeof obj.label === "string" ? obj.label : undefined,
            };
          }
          return null;
        })
        .filter((k): k is ProviderKeyInput => k !== null);
    } catch {
      // Fall through to line-delimited parsing
    }
  }

  // Newline-delimited text
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((credential) => ({
      credential,
      metadata: defaultMetadata,
    }));
}

const IMPORT_TIMEOUT_MS = 30_000;
const IMPORT_MAX_BYTES = 10 * 1024 * 1024;

export async function importKeysFromUrl(
  db: DB,
  providerId: string,
  url: string,
  options: {
    headers?: Record<string, string>;
    mode?: "append" | "replace";
    defaultMetadata?: Record<string, string>;
  } = {},
): Promise<ImportResult> {
  const mode = options.mode ?? "append";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMPORT_TIMEOUT_MS);

  let text: string;
  try {
    const resp = await fetch(url, {
      headers: options.headers,
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > IMPORT_MAX_BYTES)
      throw new Error(
        `response too large (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB, limit ${IMPORT_MAX_BYTES / 1024 / 1024} MB)`,
      );
    text = new TextDecoder().decode(buf);
  } finally {
    clearTimeout(timer);
  }

  const keys = parseKeysFromResponse(text, options.defaultMetadata);
  if (keys.length === 0 && mode === "append")
    return {
      batch: {
        added: 0,
        removed: 0,
        updated: 0,
        enabled: 0,
        disabled: 0,
        duplicatesSkipped: 0,
        errors: [],
        keys: listProviderKeys(db, providerId),
      },
      fetched: 0,
      mode,
    };

  const batch = reconcileImportedKeys(db, providerId, keys, mode);
  return { batch, fetched: keys.length, mode };
}

export function reconcileImportedKeys(
  db: DB,
  providerId: string,
  keys: ProviderKeyInput[],
  mode: "append" | "replace",
): BatchKeyResult {
  const existing = listProviderKeys(db, providerId);
  const existingByCredential = new Map(
    existing.map((key) => [key.credential, key]),
  );
  const updates = keys.flatMap((input) => {
    const saved = existingByCredential.get(input.credential);
    if (!saved) return [];
    return [
      {
        id: saved.id,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(mode === "replace" || input.enabled !== undefined
          ? { enabled: input.enabled !== false }
          : {}),
      },
    ];
  });

  if (mode === "replace") {
    // Source of truth: keys not in the response get disabled (not deleted).
    // Existing keys are also structured upserts: metadata/label changes from
    // the source are applied, and explicit enabled:false is respected.
    const importedCreds = new Set(keys.map((k) => k.credential));
    const disableIds = existing
      .filter((k) => k.enabled && !importedCreds.has(k.credential))
      .map((k) => k.id);

    return batchProviderKeys(db, providerId, {
      add: keys.length ? keys : undefined,
      update: updates.length ? updates : undefined,
      disable: disableIds.length ? disableIds : undefined,
    });
  }

  // Append mode: add new keys and update structured fields supplied for an
  // existing credential; omitted fields remain untouched.
  return batchProviderKeys(db, providerId, {
    add: keys,
    update: updates.length ? updates : undefined,
  });
}
