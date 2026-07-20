// Provider key CRUD, batch operations, URL import, and sync config routes.

import { getProvider } from "../../repo/providers";
import {
  listProviderKeys,
  getProviderKey,
  createProviderKey,
  updateProviderKey,
  deleteProviderKey,
  batchProviderKeys,
  getKeySyncConfig,
  upsertKeySyncConfig,
  deleteKeySyncConfig,
} from "../../repo/provider-keys";
import { importKeysFromUrl } from "../../services/key-import";
import type { RouteCtx } from "./types";
import {
  parseProviderKeyInput,
  parseProviderKeyUpdate,
  parseBatchKeyOps,
  parseKeyImportRequest,
  parseKeySyncInput,
} from "./parsers";
import { num } from "./parsers";
import { bad } from "./respond";

export function registerProviderKeyRoutes(ctx: RouteCtx): void {
  const { db, router, r, requireAdmin, broadcast, keySyncService } = ctx;

  const reload = () => {
    router.reload();
    broadcast(["providers"], "provider:update");
  };

  // Guard: resolve provider or 404
  const withProvider = (id: string, res: import("express").Response) => {
    const p = getProvider(db, id);
    if (!p) res.status(404).json({ error: { message: "provider not found" } });
    return p;
  };

  // --- list keys (paginated) ---
  r.get("/providers/:id/keys", requireAdmin, (req, res) => {
    if (!withProvider(String(req.params.id), res)) return;
    const providerId = String(req.params.id);
    const offset = num(req.query.offset) ?? 0;
    const limit = num(req.query.limit) ?? 0;
    const all = listProviderKeys(db, providerId);
    const keys =
      limit > 0 ? all.slice(offset, offset + limit) : all.slice(offset);
    res.json({ keys, total: all.length, offset, limit });
  });

  // --- create single key ---
  r.post("/providers/:id/keys", requireAdmin, (req, res) => {
    if (!withProvider(String(req.params.id), res)) return;
    try {
      const input = parseProviderKeyInput(req.body);
      const key = createProviderKey(db, String(req.params.id), input);
      reload();
      res.status(201).json(key);
    } catch (e) {
      bad(res, e);
    }
  });

  // --- update single key ---
  r.put("/providers/:id/keys/:keyId", requireAdmin, (req, res) => {
    if (!withProvider(String(req.params.id), res)) return;
    try {
      const existing = getProviderKey(db, String(req.params.keyId));
      if (!existing || existing.providerId !== String(req.params.id))
        return res.status(404).json({ error: { message: "key not found" } });
      const patch = parseProviderKeyUpdate(req.body);
      const updated = updateProviderKey(db, String(req.params.keyId), patch);
      reload();
      res.json(updated);
    } catch (e) {
      bad(res, e);
    }
  });

  // --- delete single key ---
  r.delete("/providers/:id/keys/:keyId", requireAdmin, (req, res) => {
    if (!withProvider(String(req.params.id), res)) return;
    const existing = getProviderKey(db, String(req.params.keyId));
    if (!existing || existing.providerId !== String(req.params.id))
      return res.status(404).json({ error: { message: "key not found" } });
    deleteProviderKey(db, String(req.params.keyId));
    reload();
    res.status(204).end();
  });

  // --- batch operations ---
  r.post("/providers/:id/keys/batch", requireAdmin, (req, res) => {
    if (!withProvider(String(req.params.id), res)) return;
    try {
      const ops = parseBatchKeyOps(req.body);
      const result = batchProviderKeys(db, String(req.params.id), ops);
      reload();
      res.json(result);
    } catch (e) {
      bad(res, e);
    }
  });

  // --- URL import ---
  r.post("/providers/:id/keys/import", requireAdmin, async (req, res) => {
    if (!withProvider(String(req.params.id), res)) return;
    try {
      const input = parseKeyImportRequest(req.body);
      const result = await importKeysFromUrl(
        db,
        String(req.params.id),
        input.url,
        {
          headers: input.headers,
          mode: input.mode,
          defaultMetadata: input.defaultMetadata,
        },
      );
      reload();
      res.json(result);
    } catch (e) {
      bad(res, e);
    }
  });

  // --- sync config CRUD ---
  r.get("/providers/:id/keys/sync", requireAdmin, (req, res) => {
    if (!withProvider(String(req.params.id), res)) return;
    const config = getKeySyncConfig(db, String(req.params.id));
    res.json(config ?? null);
  });

  r.put("/providers/:id/keys/sync", requireAdmin, (req, res) => {
    if (!withProvider(String(req.params.id), res)) return;
    try {
      const input = parseKeySyncInput(req.body);
      const config = upsertKeySyncConfig(db, String(req.params.id), input);
      keySyncService?.register(config);
      res.json(config);
    } catch (e) {
      bad(res, e);
    }
  });

  r.delete("/providers/:id/keys/sync", requireAdmin, (req, res) => {
    if (!withProvider(String(req.params.id), res)) return;
    deleteKeySyncConfig(db, String(req.params.id));
    keySyncService?.unregister(String(req.params.id));
    res.status(204).end();
  });

  // Manual sync trigger: imports keys from the configured poll URL immediately
  r.post("/providers/:id/keys/sync/trigger", requireAdmin, async (req, res) => {
    if (!withProvider(String(req.params.id), res)) return;
    const providerId = String(req.params.id);
    const config = getKeySyncConfig(db, providerId);
    if (!config)
      return res
        .status(404)
        .json({ error: { message: "no sync config for this provider" } });
    try {
      const result = await importKeysFromUrl(db, providerId, config.pollUrl, {
        headers: config.pollHeaders,
        mode: "replace",
      });
      reload();
      res.json(result);
    } catch (e) {
      bad(res, e);
    }
  });
}
