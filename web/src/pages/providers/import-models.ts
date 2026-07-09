// Import upstream models into a provider's imported-model catalog.
//
// Importing NEVER creates exposed models. Each selected upstream id becomes a
// `provider_models` row (idempotent by (provider, upstream_id)). Exposed models
// are authored separately as chains that reference these imported entries.

import { api } from "@/lib/api";

export interface ImportResult {
  created: number;
  skipped: number;
}

export async function importModelsForProvider(
  providerId: string,
  upstreamIds: Iterable<string>,
): Promise<ImportResult> {
  const list = [...upstreamIds];
  const result: ImportResult = { created: 0, skipped: 0 };
  if (list.length === 0) return result;

  const existing = await api.listProviderModels(providerId);
  const have = new Set(existing.map((m) => m.upstreamId));

  for (const upstreamId of list) {
    if (have.has(upstreamId)) {
      result.skipped++;
      continue;
    }
    try {
      await api.createProviderModel(providerId, { upstreamId });
      result.created++;
    } catch {
      result.skipped++;
    }
  }
  return result;
}
