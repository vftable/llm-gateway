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
import { keyStats } from "../../repo/request-logs";
import { KeyHealthStore } from "../../gateway/key-health";
import type { Response } from "express";
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

  const withHealth = <T extends { providerId: string; credHash: string }>(
    keys: T[],
  ) => {
    const health = new KeyHealthStore(db);
    return keys.map((key) => {
      const h = health.snapshot(key.providerId, key.credHash);
      return {
        ...key,
        health: {
          usable: h.usable,
          dead: h.authFailed,
          ...(h.rateLimitedUntilIso
            ? { rateLimitedUntil: h.rateLimitedUntilIso }
            : {}),
          ...(h.lastErrorStatus !== null
            ? { lastErrorStatus: h.lastErrorStatus }
            : {}),
          ...(h.lastError ? { lastError: h.lastError } : {}),
          ...(h.lastErrorAt ? { lastErrorAt: h.lastErrorAt } : {}),
        },
      };
    });
  };

  // Guard: resolve provider or 404
  const withProvider = (id: string, res: Response) => {
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
    res.json({ keys: withHealth(keys), total: all.length, offset, limit });
  });

  // Per-key success/error counts for the key manager table — keyed by
  // cred_hash, the same identity a credential is looked up by. Auth failures
  // (401/403) short-circuit out of the retry loop before a request_logs row
  // is ever written (see engine.ts forward()), so they'd be invisible to the
  // key manager's error count if it only read request_logs — merge in
  // KeyHealthStore's own lifetime auth-fail counter to cover that gap.
  r.get("/providers/:id/keys/stats", requireAdmin, (req, res) => {
    const providerId = String(req.params.id);
    if (!withProvider(providerId, res)) return;
    const logStats = keyStats(db, providerId);
    const byHash = new Map(logStats.map((s) => [s.credHash, s]));
    const health = new KeyHealthStore(db);
    for (const key of listProviderKeys(db, providerId)) {
      const authFailCount = health.snapshot(
        providerId,
        key.credHash,
      ).authFailCount;
      if (!authFailCount) continue;
      const existing = byHash.get(key.credHash);
      if (existing) existing.errors += authFailCount;
      else
        byHash.set(key.credHash, {
          credHash: key.credHash,
          success: 0,
          errors: authFailCount,
        });
    }
    res.json([...byHash.values()]);
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

  // --- update single key ---
  // Registered after every literal /keys/<word> route above (stats, batch,
  // import, sync, sync/trigger) — Express matches routes in registration
  // order, and this wildcard would otherwise swallow those literal paths
  // (e.g. PUT /keys/sync arriving here with keyId="sync" and 404ing).
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
}
