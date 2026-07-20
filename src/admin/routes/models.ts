// Exposed-model (fallback chain) CRUD, plus the transform library route.

import type { Database as DB } from "better-sqlite3";
import {
  batchModelLinks,
  createModel,
  deleteModel,
  getModel,
  listModels,
  updateModel,
  type ModelInput,
} from "../../repo/models";
import { getProvider, listProviders } from "../../repo/providers";
import {
  getProviderModel,
  upsertProviderModel,
} from "../../repo/provider-models";
import { listTransformDefs } from "../../formats/transforms";
import { hopStats } from "../../repo/request-logs";
import type { Model } from "../../types";
import type { UpstreamModel } from "../../providers";
import type { RouteCtx } from "./types";
import {
  parseBatchModelLinkOps,
  parseBatchModelOps,
  parseModelInput,
} from "./parsers";
import { fetchProviderModels, testProviderModel } from "./provider-probe";
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
      const models = await fetchProviderModels(provider, db);
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
  const { db, logger, router, r, requireAdmin, broadcast } = ctx;

  // --- models (with fallback chain) ---
  r.get("/models", requireAdmin, (_req, res) => res.json(listModels(db)));

  r.post("/models", requireAdmin, async (req, res) => {
    try {
      const input = parseModelInput(req.body, true);
      await autoCreateImportedModels(db, input);
      const m = createModel(db, input);
      router.reload();
      broadcast(["models", "overview"], "model:create");
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
      broadcast(["models", "overview"], "model:update");
      res.json(m);
    } catch (e) {
      bad(res, e);
    }
  });

  r.delete("/models/:id", requireAdmin, (req, res) => {
    if (!deleteModel(db, String(req.params.id)))
      return res.status(404).json({ error: { message: "not found" } });
    router.reload();
    broadcast(["models", "overview"], "model:delete");
    res.status(204).end();
  });

  // Test an exposed model by resolving its provider chain and probing the
  // first viable hop — same chain-walk the forwarding engine uses, but via
  // the adapter's testModel() seam instead of a live completion.
  r.post("/models/:id/test", requireAdmin, async (req, res) => {
    const model = getModel(db, String(req.params.id));
    if (!model)
      return res.status(404).json({ error: { message: "not found" } });

    const enabledProviders = new Map(
      listProviders(db, false).map((p) => [p.id, p]),
    );

    for (let i = 0; i < model.providers.length; i++) {
      const link = model.providers[i];
      if (!link.enabled) continue;
      const provider = enabledProviders.get(link.providerId);
      if (!provider || !provider.enabled) continue;

      const imported = getProviderModel(db, provider.id, link.upstreamModel);
      try {
        const result = await testProviderModel(
          provider,
          link.upstreamModel,
          db,
          logger,
          imported?.transforms,
        );
        return res.json({
          ...result,
          provider: { id: provider.id, name: provider.name },
          upstreamModel: link.upstreamModel,
          hopIndex: i,
        });
      } catch (e) {
        return res.json({
          ok: false,
          status: null,
          data: { message: (e as Error).message },
          ms: 0,
          provider: { id: provider.id, name: provider.name },
          upstreamModel: link.upstreamModel,
          hopIndex: i,
        });
      }
    }

    res.json({
      ok: false,
      status: null,
      data: {
        message:
          "No viable provider in the fallback chain (all disabled or missing)",
      },
      ms: 0,
      provider: null,
      upstreamModel: null,
      hopIndex: -1,
    });
  });

  // --- models batch ---
  r.post("/models/batch", requireAdmin, async (req, res) => {
    try {
      const ops = parseBatchModelOps(req.body);
      const result = {
        created: [] as Model[],
        updated: [] as Model[],
        deleted: 0,
        enabled: 0,
        disabled: 0,
        errors: [] as Array<{ op: string; id?: string; detail: string }>,
      };

      // Auto-create imported models for any new chain links
      if (ops.create) {
        for (const input of ops.create) {
          try {
            await autoCreateImportedModels(db, input);
          } catch {
            /* best effort */
          }
        }
      }
      if (ops.update) {
        for (const { id, ...input } of ops.update) {
          try {
            await autoCreateImportedModels(db, input as ModelInput);
          } catch {
            /* best effort */
          }
        }
      }

      const tx = db.transaction(() => {
        if (ops.create) {
          for (const input of ops.create) {
            try {
              result.created.push(createModel(db, input));
            } catch (e) {
              result.errors.push({
                op: "create",
                detail: (e as Error).message,
              });
            }
          }
        }
        if (ops.update) {
          for (const { id, ...input } of ops.update) {
            const m = updateModel(db, id, input);
            if (m) result.updated.push(m);
            else result.errors.push({ op: "update", id, detail: "not found" });
          }
        }
        if (ops.enable) {
          for (const id of ops.enable) {
            const m = updateModel(db, id, { enabled: true });
            if (m) result.enabled++;
            else result.errors.push({ op: "enable", id, detail: "not found" });
          }
        }
        if (ops.disable) {
          for (const id of ops.disable) {
            const m = updateModel(db, id, { enabled: false });
            if (m) result.disabled++;
            else result.errors.push({ op: "disable", id, detail: "not found" });
          }
        }
        if (ops.delete) {
          for (const id of ops.delete) {
            if (deleteModel(db, id)) result.deleted++;
            else result.errors.push({ op: "delete", id, detail: "not found" });
          }
        }
      });
      tx();

      router.reload();
      broadcast(["models", "overview"], "model:batch");
      res.json(result);
    } catch (e) {
      bad(res, e);
    }
  });

  // --- model provider-link batch (fallback chain) ---
  r.post("/models/:id/providers/batch", requireAdmin, async (req, res) => {
    try {
      const modelId = String(req.params.id);
      if (!getModel(db, modelId))
        return res.status(404).json({ error: { message: "not found" } });
      const ops = parseBatchModelLinkOps(req.body);
      if (ops.add?.length) {
        await autoCreateImportedModels(db, {
          alias: "",
          providers: ops.add,
        });
      }
      const result = batchModelLinks(db, modelId, ops);
      router.reload();
      broadcast(["models", "overview"], "model-providers:batch");
      res.json(result);
    } catch (e) {
      bad(res, e);
    }
  });

  // --- transform library (for the per-model transform editor) ---
  r.get("/transforms", requireAdmin, (_req, res) =>
    res.json(listTransformDefs()),
  );
}
