// Provider-models repository. CRUD for the per-provider imported-model catalog.
// These rows are the building blocks a chain link references; they are never
// exposed on /v1/models.

import type { Database as DB } from "better-sqlite3";
import type {
  ProviderModel,
  ProviderModelInput,
  ModelTransformConfig,
  ModelCapabilities,
} from "../types";
import { parseJsonArray, parseJsonObject } from "./json";

interface ProviderModelRow {
  id: number;
  provider_id: string;
  upstream_id: string;
  display_name: string | null;
  context_window: number | null;
  max_output_tokens: number | null;
  capabilities: string | null;
  transforms: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function mapProviderModel(r: ProviderModelRow): ProviderModel {
  return {
    id: r.id,
    providerId: r.provider_id,
    upstreamId: r.upstream_id,
    displayName: r.display_name,
    contextWindow: r.context_window,
    maxOutputTokens: r.max_output_tokens,
    capabilities: parseJsonObject<ModelCapabilities | null>(
      r.capabilities,
      null,
    ),
    transforms: parseJsonArray<ModelTransformConfig>(r.transforms),
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Serialize capabilities for storage: an object → JSON, anything else → null.
function serializeCapabilities(
  caps: ModelCapabilities | null | undefined,
): string | null {
  return caps ? JSON.stringify(caps) : null;
}

export function listProviderModels(
  db: DB,
  providerId: string,
): ProviderModel[] {
  const rows = db
    .prepare(
      "SELECT * FROM provider_models WHERE provider_id = ? ORDER BY upstream_id",
    )
    .all(providerId) as ProviderModelRow[];
  return rows.map(mapProviderModel);
}

// All imported models across providers (for chain-editor lookups).
export function listAllProviderModels(db: DB): ProviderModel[] {
  const rows = db
    .prepare("SELECT * FROM provider_models ORDER BY provider_id, upstream_id")
    .all() as ProviderModelRow[];
  return rows.map(mapProviderModel);
}

// Number of imported models per provider id, in one query. Powers the provider
// card's "N imported" badge without fetching every row.
export function countProviderModelsByProvider(db: DB): Record<string, number> {
  const rows = db
    .prepare(
      "SELECT provider_id, COUNT(*) AS n FROM provider_models GROUP BY provider_id",
    )
    .all() as Array<{ provider_id: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.provider_id] = r.n;
  return out;
}

export function getProviderModel(
  db: DB,
  providerId: string,
  upstreamId: string,
): ProviderModel | null {
  const row = db
    .prepare(
      "SELECT * FROM provider_models WHERE provider_id = ? AND upstream_id = ?",
    )
    .get(providerId, upstreamId) as ProviderModelRow | undefined;
  return row ? mapProviderModel(row) : null;
}

export function getProviderModelById(db: DB, id: number): ProviderModel | null {
  const row = db
    .prepare("SELECT * FROM provider_models WHERE id = ?")
    .get(id) as ProviderModelRow | undefined;
  return row ? mapProviderModel(row) : null;
}

// Insert or update by (provider_id, upstream_id). Used both by explicit import
// and by chain-save auto-create (which only supplies the identity, leaving
// metadata untouched when the row already exists).
export function upsertProviderModel(
  db: DB,
  input: ProviderModelInput,
): ProviderModel {
  const now = new Date().toISOString();
  const existing = getProviderModel(db, input.providerId, input.upstreamId);
  if (existing) {
    // Only overwrite fields explicitly provided; auto-create passes none.
    return (
      updateProviderModel(db, existing.id, {
        displayName: input.displayName,
        contextWindow: input.contextWindow,
        maxOutputTokens: input.maxOutputTokens,
        capabilities: input.capabilities,
        transforms: input.transforms,
        notes: input.notes,
      }) ?? existing
    );
  }
  db.prepare(
    `INSERT INTO provider_models
       (provider_id, upstream_id, display_name, context_window,
        max_output_tokens, capabilities, transforms, notes, created_at, updated_at)
     VALUES (@provider_id, @upstream_id, @display_name, @context_window,
        @max_output_tokens, @capabilities, @transforms, @notes, @created_at, @updated_at)`,
  ).run({
    provider_id: input.providerId,
    upstream_id: input.upstreamId,
    display_name: input.displayName ?? null,
    context_window: input.contextWindow ?? null,
    max_output_tokens: input.maxOutputTokens ?? null,
    capabilities: serializeCapabilities(input.capabilities),
    transforms: JSON.stringify(input.transforms ?? []),
    notes: input.notes ?? null,
    created_at: now,
    updated_at: now,
  });
  return getProviderModel(db, input.providerId, input.upstreamId)!;
}

export function updateProviderModel(
  db: DB,
  id: number,
  patch: Partial<Omit<ProviderModelInput, "providerId" | "upstreamId">>,
): ProviderModel | null {
  const existing = getProviderModelById(db, id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const next = {
    display_name:
      patch.displayName !== undefined
        ? patch.displayName
        : existing.displayName,
    context_window:
      patch.contextWindow !== undefined
        ? patch.contextWindow
        : existing.contextWindow,
    max_output_tokens:
      patch.maxOutputTokens !== undefined
        ? patch.maxOutputTokens
        : existing.maxOutputTokens,
    capabilities:
      patch.capabilities !== undefined
        ? patch.capabilities
        : existing.capabilities,
    transforms:
      patch.transforms !== undefined ? patch.transforms : existing.transforms,
    notes: patch.notes !== undefined ? patch.notes : existing.notes,
  };
  db.prepare(
    `UPDATE provider_models SET
       display_name=@display_name, context_window=@context_window,
       max_output_tokens=@max_output_tokens, capabilities=@capabilities,
       transforms=@transforms, notes=@notes, updated_at=@updated_at
     WHERE id=@id`,
  ).run({
    id,
    display_name: next.display_name ?? null,
    context_window: next.context_window ?? null,
    max_output_tokens: next.max_output_tokens ?? null,
    capabilities: serializeCapabilities(next.capabilities),
    transforms: JSON.stringify(next.transforms ?? []),
    notes: next.notes ?? null,
    updated_at: now,
  });
  return getProviderModelById(db, id);
}

export function deleteProviderModel(db: DB, id: number): boolean {
  const r = db.prepare("DELETE FROM provider_models WHERE id = ?").run(id);
  return r.changes > 0;
}
