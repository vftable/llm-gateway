// Exposed-model (fallback chain) CRUD, plus the transform library route.

import type { Database as DB } from "better-sqlite3";
import {
  createModel,
  deleteModel,
  getModel,
  listModels,
  updateModel,
  type ModelInput,
} from "../../repo/models";
import { getProvider } from "../../repo/providers";
import {
  getProviderModel,
  upsertProviderModel,
} from "../../repo/provider-models";
import { listTransformDefs } from "../../formats/transforms";
import { hopStats } from "../../repo/request-logs";
import type { UpstreamModel } from "../../providers";
import type { RouteCtx } from "./types";
import { parseModelInput } from "./parsers";
import { fetchProviderModels } from "./provider-probe";
import { bad } from "./respond";

// Reference + auto-create: ensure every (provider, upstreamModel) a chain
// references exists in that provider's imported catalog. Missing ones are
// best-effort enriched via the provider's fetchModels() seam — same discovery
// data the explicit Import sheet uses — so a chain-save doesn't leave the row
// blank on capabilities/context/max-out. Falls back to bare identity if the
// fetch fails or the id isn't found upstream (e.g. hand-typed). Never blocks
// the save. Existing rows are left untouched (idempotent identity upsert).
async function autoCreateImportedModels(
  db: DB,
  input: ModelInput,
): Promise<void> {
  const links = (input.providers ?? []).filter(
    (l) => l.providerId && l.upstreamModel,
  );
  const newByProvider = new Map<string, Set<string>>();
  for (const link of links) {
    if (getProviderModel(db, link.providerId, link.upstreamModel)) continue;
    const set = newByProvider.get(link.providerId) ?? new Set<string>();
    set.add(link.upstreamModel);
    newByProvider.set(link.providerId, set);
  }
  const upstreamByProvider = new Map<string, Map<string, UpstreamModel>>();
  for (const [providerId] of newByProvider) {
    const provider = getProvider(db, providerId);
    if (!provider) continue;
    try {
      const models = await fetchProviderModels(provider);
      upstreamByProvider.set(providerId, new Map(models.map((m) => [m.id, m])));
    } catch {
      // Best-effort — fall back to bare identity for this provider's links.
    }
  }
  for (const link of links) {
    if (getProviderModel(db, link.providerId, link.upstreamModel)) continue;
    const found = upstreamByProvider
      .get(link.providerId)
      ?.get(link.upstreamModel);
    upsertProviderModel(db, {
      providerId: link.providerId,
      upstreamId: link.upstreamModel,
      displayName: found?.displayName ?? undefined,
      contextWindow: found?.contextWindow ?? undefined,
      maxOutputTokens: found?.maxOutputTokens ?? undefined,
      capabilities: found?.capabilities ?? undefined,
    });
  }
}

export function registerModelRoutes(ctx: RouteCtx): void {
  const { db, router, r, requireAdmin } = ctx;

  // --- models (with fallback chain) ---
  r.get("/models", requireAdmin, (_req, res) => res.json(listModels(db)));

  r.post("/models", requireAdmin, async (req, res) => {
    try {
      const input = parseModelInput(req.body, true);
      await autoCreateImportedModels(db, input);
      const m = createModel(db, input);
      router.reload();
      res.status(201).json(m);
    } catch (e) {
      bad(res, e);
    }
  });

  r.get("/models/:id", requireAdmin, (req, res) => {
    const m = getModel(db, String(req.params.id));
    if (!m) return res.status(404).json({ error: { message: "not found" } });
    res.json(m);
  });

  // Per-hop success/error counts for the chain editor — keyed by (providerId,
  // upstreamModel), the same identity a chain link routes through.
  r.get("/models/:id/hop-stats", requireAdmin, (req, res) => {
    const m = getModel(db, String(req.params.id));
    if (!m) return res.status(404).json({ error: { message: "not found" } });
    res.json(hopStats(db, m.alias));
  });

  r.put("/models/:id", requireAdmin, async (req, res) => {
    try {
      const input = parseModelInput(req.body);
      await autoCreateImportedModels(db, input);
      const m = updateModel(db, String(req.params.id), input);
      if (!m) return res.status(404).json({ error: { message: "not found" } });
      router.reload();
      res.json(m);
    } catch (e) {
      bad(res, e);
    }
  });

  r.delete("/models/:id", requireAdmin, (req, res) => {
    if (!deleteModel(db, String(req.params.id)))
      return res.status(404).json({ error: { message: "not found" } });
    router.reload();
    res.status(204).end();
  });

  // --- transform library (for the per-model transform editor) ---
  r.get("/transforms", requireAdmin, (_req, res) =>
    res.json(listTransformDefs()),
  );
}
