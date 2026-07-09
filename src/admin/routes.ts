// Admin REST API under /api. All endpoints (except auth/login and auth/check)
// require a valid admin session token. Mutations that affect the gateway's
// live view (providers, models, settings) trigger a registry reload so changes
// take effect without a restart.

import { Router } from "express";
import type { Request, Response } from "express";
import http from "http";
import https from "https";
import { URL } from "url";
import type { Database as DB } from "better-sqlite3";
import type { Logger } from "../logger";
import type { GatewayRouter } from "../gateway/router";
import type { AdminAuth } from "../auth/admin-auth";
import {
  adminAuthMiddleware,
  changeAdminPassword,
  login as adminLogin,
} from "../auth/admin-auth";
import {
  createProvider,
  deleteProvider,
  getProvider,
  listProviders,
  updateProvider,
  type ProviderInput,
} from "../repo/providers";
import {
  createModel,
  deleteModel,
  getModel,
  listModels,
  updateModel,
  type ModelInput,
} from "../repo/models";
import {
  listProviderModels,
  upsertProviderModel,
  updateProviderModel,
  deleteProviderModel,
  getProviderModelById,
  countProviderModelsByProvider,
} from "../repo/provider-models";
import { listTransformDefs } from "../formats/transforms";
import {
  createUser,
  deleteUser,
  getUser,
  listUsers,
  updateUser,
  type UserInput,
} from "../repo/users";
import {
  createApiKey,
  deleteApiKey,
  getApiKey,
  getApiKeyFull,
  listApiKeys,
  updateApiKey,
  type ApiKeyInput,
} from "../repo/api-keys";
import {
  listUsageToday,
  totalUsageHistory,
  hourlyUsageHistory,
  totalUsageToday,
  fullBreakdownToday,
  breakdownForKey,
  modelResolution,
  rebuildUsageFromLogs,
} from "../repo/usage";
import {
  dashboardStats,
  listRequestLogs,
  clearRequestLogs,
  getRequestLogDetail,
} from "../repo/request-logs";
import { vacuumFreePages } from "../db";
import { getSettings, saveSettings } from "../repo/settings";
import { listWebProviders } from "../web-tools/backends";
import { listProviderTemplates } from "../providers";
import { agentFor } from "../gateway/proxy-agent";
import type {
  AuthScheme,
  ModelCapabilities,
  ModelTransformConfig,
  Settings,
} from "../types";

export function adminRouter(
  db: DB,
  logger: Logger,
  router: GatewayRouter,
  auth: AdminAuth,
): Router {
  const r = Router();
  const requireAdmin = adminAuthMiddleware(auth.secret);

  const bad = (res: Response, err: unknown, code = 400): void => {
    const msg =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : "Bad request";
    res.status(code).json({ error: { type: "bad_request", message: msg } });
  };

  // --- auth ---
  r.post("/auth/login", (req, res) => {
    const password = (req.body as { password?: string })?.password;
    if (!password)
      return res.status(400).json({ error: { message: "password required" } });
    const token = adminLogin(db, auth, password);
    if (!token)
      return res.status(401).json({ error: { message: "Invalid password" } });
    res.json({ token });
  });

  r.get("/auth/check", requireAdmin, (_req, res) => res.json({ ok: true }));

  // --- overview / stats ---
  r.get("/overview", requireAdmin, (_req, res) => {
    res.json({
      stats: dashboardStats(db),
      usageHistory: totalUsageHistory(db, 14),
      hourlyUsage: hourlyUsageHistory(db, 24),
      providers: listProviders(db).length,
      models: listModels(db).length,
      keys: listApiKeys(db).filter((k) => k.enabled).length,
    });
  });

  // --- providers ---
  // Attach importedModelCount (rows in provider_models) so the card badge shows
  // the true registered-imported count, not the exposed-chain hop count.
  r.get("/providers", requireAdmin, (_req, res) => {
    const counts = countProviderModelsByProvider(db);
    res.json(
      listProviders(db).map((p) => ({
        ...p,
        importedModelCount: counts[p.id] ?? 0,
      })),
    );
  });

  r.post("/providers", requireAdmin, (req, res) => {
    try {
      const input = parseProviderInput(req.body, true);
      const p = createProvider(db, input);
      router.reload();
      res.status(201).json(p);
    } catch (e) {
      bad(res, e);
    }
  });

  r.get("/providers/:id", requireAdmin, (req, res) => {
    const p = getProvider(db, String(req.params.id));
    if (!p) return res.status(404).json({ error: { message: "not found" } });
    res.json(p);
  });

  r.put("/providers/:id", requireAdmin, (req, res) => {
    try {
      const id = String(req.params.id);
      const p = updateProvider(db, id, parseProviderInput(req.body));
      if (!p) return res.status(404).json({ error: { message: "not found" } });
      router.reload();
      res.json(p);
    } catch (e) {
      bad(res, e);
    }
  });

  r.delete("/providers/:id", requireAdmin, (req, res) => {
    if (!deleteProvider(db, String(req.params.id)))
      return res.status(404).json({ error: { message: "not found" } });
    router.reload();
    res.status(204).end();
  });

  // Live test: GET {baseUrl}/v1/models with the provider's auth.
  r.post("/providers/:id/test", requireAdmin, async (req, res) => {
    const provider = getProvider(db, String(req.params.id));
    if (!provider)
      return res.status(404).json({ error: { message: "not found" } });
    try {
      const result = await testProvider(provider);
      res.json(result);
    } catch (e) {
      res.json({ ok: false, status: null, ms: 0, error: (e as Error).message });
    }
  });

  // Probe upstream models: GET {baseUrl}/v1/models, parse IDs.
  r.get("/providers/:id/upstream-models", requireAdmin, async (req, res) => {
    const provider = getProvider(db, String(req.params.id));
    if (!provider)
      return res.status(404).json({ error: { message: "not found" } });
    try {
      const models = await fetchUpstreamModels(provider);
      res.json({ models });
    } catch (e) {
      res.json({ models: [], error: (e as Error).message });
    }
  });

  // --- provider catalog (stock provider registry) ---
  // Static list of provider templates the Add-Provider wizard renders.
  r.get("/provider-catalog", requireAdmin, (_req, res) =>
    res.json(listProviderTemplates()),
  );

  // Pre-create connectivity test + upstream model discovery. Lets the wizard
  // test a provider BEFORE its row exists, from an ad-hoc config. Reuses the
  // same probe helpers as the saved-provider test.
  r.post("/provider-catalog/test", requireAdmin, async (req, res) => {
    const b = (req.body || {}) as Record<string, unknown>;
    const baseUrl = str(b.baseUrl);
    if (!baseUrl)
      return res.status(400).json({ error: { message: "baseUrl is required" } });
    const apiKey = str(b.apiKey);
    const probe: ProviderLike = {
      baseUrl,
      host: b.host == null ? null : (str(b.host) ?? null),
      apiKeys: apiKey ? [apiKey] : [],
      authScheme:
        b.authScheme === "bearer" ||
        b.authScheme === "xapikey" ||
        b.authScheme === "both" ||
        b.authScheme === "passthrough"
          ? (b.authScheme as AuthScheme)
          : "bearer",
      tlsVerify: b.tlsVerify === undefined ? true : !!b.tlsVerify,
      extraHeaders:
        b.extraHeaders && typeof b.extraHeaders === "object"
          ? (b.extraHeaders as Record<string, string>)
          : {},
      basePath: str(b.basePath) ?? "",
      modelsPath: str(b.modelsPath) ?? "/v1/models",
      proxy: b.proxy == null ? null : str(b.proxy),
    };
    try {
      const result = await testProvider(probe);
      // Best-effort model discovery; failures don't fail the test.
      let models: string[] = [];
      if (result.ok) {
        try {
          models = await fetchUpstreamModels(probe);
        } catch {
          models = [];
        }
      }
      res.json({ ...result, models });
    } catch (e) {
      res.json({
        ok: false,
        status: null,
        ms: 0,
        error: (e as Error).message,
        models: [],
      });
    }
  });

  // --- models (with fallback chain) ---
  r.get("/models", requireAdmin, (_req, res) => res.json(listModels(db)));

  r.post("/models", requireAdmin, (req, res) => {
    try {
      const input = parseModelInput(req.body, true);
      autoCreateImportedModels(db, input);
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

  r.put("/models/:id", requireAdmin, (req, res) => {
    try {
      const input = parseModelInput(req.body);
      autoCreateImportedModels(db, input);
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

  // --- imported provider models (per-provider catalog, not exposed) ---
  r.get("/providers/:id/models", requireAdmin, (req, res) =>
    res.json(listProviderModels(db, String(req.params.id))),
  );

  r.post("/providers/:id/models", requireAdmin, (req, res) => {
    try {
      const providerId = String(req.params.id);
      if (!getProvider(db, providerId))
        return res.status(404).json({ error: { message: "provider not found" } });
      const b = (req.body || {}) as Record<string, unknown>;
      const upstreamId = str(b.upstreamId);
      if (!upstreamId)
        return res
          .status(400)
          .json({ error: { message: "upstreamId is required" } });
      const pm = upsertProviderModel(db, {
        providerId,
        upstreamId,
        displayName: b.displayName == null ? null : str(b.displayName),
        contextWindow: b.contextWindow == null ? null : num(b.contextWindow),
        maxOutputTokens:
          b.maxOutputTokens == null ? null : num(b.maxOutputTokens),
        transforms: parseTransformConfig(b.transforms),
        notes: b.notes == null ? null : str(b.notes),
      });
      res.status(201).json(pm);
    } catch (e) {
      bad(res, e);
    }
  });

  r.put("/providers/:id/models/:mid", requireAdmin, (req, res) => {
    try {
      const mid = Number(req.params.mid);
      const existing = getProviderModelById(db, mid);
      if (!existing || existing.providerId !== String(req.params.id))
        return res.status(404).json({ error: { message: "not found" } });
      const b = (req.body || {}) as Record<string, unknown>;
      const pm = updateProviderModel(db, mid, {
        displayName:
          b.displayName === undefined
            ? undefined
            : b.displayName == null
              ? null
              : str(b.displayName),
        contextWindow:
          b.contextWindow === undefined
            ? undefined
            : b.contextWindow == null
              ? null
              : num(b.contextWindow),
        maxOutputTokens:
          b.maxOutputTokens === undefined
            ? undefined
            : b.maxOutputTokens == null
              ? null
              : num(b.maxOutputTokens),
        transforms:
          b.transforms === undefined
            ? undefined
            : parseTransformConfig(b.transforms),
        notes:
          b.notes === undefined ? undefined : b.notes == null ? null : str(b.notes),
      });
      router.reload();
      res.json(pm);
    } catch (e) {
      bad(res, e);
    }
  });

  r.delete("/providers/:id/models/:mid", requireAdmin, (req, res) => {
    const mid = Number(req.params.mid);
    const existing = getProviderModelById(db, mid);
    if (!existing || existing.providerId !== String(req.params.id))
      return res.status(404).json({ error: { message: "not found" } });
    deleteProviderModel(db, mid);
    router.reload();
    res.status(204).end();
  });

  // --- transform library (for the per-model transform editor) ---
  r.get("/transforms", requireAdmin, (_req, res) =>
    res.json(listTransformDefs()),
  );

  // --- users ---
  r.get("/users", requireAdmin, (_req, res) => res.json(listUsers(db)));

  r.post("/users", requireAdmin, (req, res) => {
    try {
      const u = createUser(db, parseUserInput(req.body, true));
      res.status(201).json(u);
    } catch (e) {
      bad(res, e);
    }
  });

  r.put("/users/:id", requireAdmin, (req, res) => {
    try {
      const u = updateUser(db, String(req.params.id), parseUserInput(req.body));
      if (!u) return res.status(404).json({ error: { message: "not found" } });
      res.json(u);
    } catch (e) {
      bad(res, e);
    }
  });

  r.delete("/users/:id", requireAdmin, (req, res) => {
    if (!deleteUser(db, String(req.params.id)))
      return res.status(404).json({ error: { message: "not found" } });
    res.status(204).end();
  });

  // --- api keys ---
  r.get("/api-keys", requireAdmin, (_req, res) => res.json(listApiKeys(db)));

  r.post("/api-keys", requireAdmin, (req, res) => {
    try {
      const input = parseApiKeyInput(req.body);
      const key = createApiKey(db, input);
      router.reload();
      res.status(201).json(key);
    } catch (e) {
      bad(res, e);
    }
  });

  // Reveal the full key value (self-hosted admin tool — operator's own keys).
  r.get("/api-keys/:id/reveal", requireAdmin, (req, res) => {
    const full = getApiKeyFull(db, String(req.params.id));
    if (full == null)
      return res.status(404).json({ error: { message: "not found" } });
    res.json({ keyFull: full });
  });

  r.put("/api-keys/:id", requireAdmin, (req, res) => {
    try {
      const k = updateApiKey(
        db,
        String(req.params.id),
        parseApiKeyInput(req.body),
      );
      if (!k) return res.status(404).json({ error: { message: "not found" } });
      res.json(k);
    } catch (e) {
      bad(res, e);
    }
  });

  r.delete("/api-keys/:id", requireAdmin, (req, res) => {
    if (!deleteApiKey(db, String(req.params.id)))
      return res.status(404).json({ error: { message: "not found" } });
    router.reload();
    res.status(204).end();
  });

  // --- usage ---
  r.get("/usage", requireAdmin, (_req, res) =>
    res.json({
      today: {
        total: totalUsageToday(db),
        keys: listUsageToday(db),
      },
      history: totalUsageHistory(db, 14),
    }),
  );

  // Per-(key, model, provider) breakdown for today — answers "this key using
  // gpt-5.5 resolved to which provider and how many tokens".
  r.get("/usage/breakdown", requireAdmin, (_req, res) =>
    res.json({ rows: fullBreakdownToday(db) }),
  );

  // Breakdown for a single key (today): which models + providers it used.
  r.get("/usage/keys/:id", requireAdmin, (req, res) =>
    res.json({ rows: breakdownForKey(db, String(req.params.id)) }),
  );

  // "If a user uses model X, what provider did it resolve to?" — per-provider
  // token/request totals for a model (today).
  r.get("/usage/models/:model", requireAdmin, (req, res) =>
    res.json({
      model: req.params.model,
      rows: modelResolution(db, String(req.params.model)),
    }),
  );

  // --- request logs ---
  r.get("/request-logs", requireAdmin, (req, res) => {
    const q = req.query as {
      limit?: string;
      offset?: string;
      apiKeyId?: string;
      model?: string;
      providerId?: string;
      error?: string;
    };
    res.json(
      listRequestLogs(db, {
        limit: q.limit ? parseInt(q.limit, 10) : 100,
        offset: q.offset ? parseInt(q.offset, 10) : 0,
        apiKeyId: q.apiKeyId,
        modelId: q.model,
        providerId: q.providerId,
        statusError: q.error === "1" || q.error === "true",
      }),
    );
  });

  // Captured request/response debug payloads for one log row, loaded on demand
  // when a row is expanded (kept out of the list to keep the feed light).
  r.get("/request-logs/:id/detail", requireAdmin, (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id))
      return res.status(400).json({ error: { message: "bad id" } });
    const detail = getRequestLogDetail(db, id);
    if (!detail)
      return res.status(404).json({ error: { message: "not found" } });
    res.json(detail);
  });

  // --- maintenance ---
  // Recompute the usage + usage_breakdown counters from request_logs (the
  // ground-truth per-request record). Fixes any drift from older builds or a
  // crash between reserve and settle. `?day=YYYY-MM-DD` scopes to one UTC day;
  // omit to rebuild every day in the logs.
  r.post("/maintenance/rebuild-usage", requireAdmin, (req, res) => {
    try {
      const day = (req.query as { day?: string }).day;
      if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day))
        throw new Error("day must be YYYY-MM-DD");
      const result = rebuildUsageFromLogs(db, day);
      logger.info("usage_rebuilt", { ...result, day: day ?? "all" });
      res.json(result);
    } catch (e) {
      bad(res, e);
    }
  });

  // Delete request logs for cleaner readings. `?scope=errors` removes only
  // failed rows; `?scope=all` clears the whole log. Frees the reclaimed pages
  // back to the OS afterward so the DB file shrinks.
  r.post("/maintenance/clear-logs", requireAdmin, (req, res) => {
    try {
      const scope = (req.query as { scope?: string }).scope ?? "errors";
      if (scope !== "errors" && scope !== "all")
        throw new Error("scope must be 'errors' or 'all'");
      const removed = clearRequestLogs(db, scope);
      if (removed > 0) vacuumFreePages(db);
      logger.info("logs_cleared", { scope, removed });
      res.json({ removed, scope });
    } catch (e) {
      bad(res, e);
    }
  });

  // --- settings ---
  // Public settings shape: never expose adminPasswordHash / jwtSecret.
  const publicSettings = () => {
    const s = getSettings(db);
    return {
      modelPrefix: s.modelPrefix,
      exposePrefix: s.exposePrefix,
      exposeExempt: s.exposeExempt,
      allowUnknown: s.allowUnknown,
      defaultMaxOutputTokens: s.defaultMaxOutputTokens,
      ssePingInterval: s.ssePingInterval,
      requestLogRetentionDays: s.requestLogRetentionDays,
      debugLogging: s.debugLogging,
      webToolsEnabled: s.webToolsEnabled,
      webToolsProvider: s.webToolsProvider,
      webProviderBaseUrl: s.webProviderBaseUrl,
      webProviderApiKey: s.webProviderApiKey,
      // Registered web-provider ids the UI can pick from.
      webProviders: listWebProviders(),
    };
  };

  r.get("/settings", requireAdmin, (_req, res) => {
    res.json(publicSettings());
  });

  r.put("/settings", requireAdmin, (req, res) => {
    const body = req.body as Partial<Settings>;
    const patch: Partial<Settings> = {};
    if (typeof body.modelPrefix === "string")
      patch.modelPrefix = body.modelPrefix;
    if (typeof body.exposePrefix === "string")
      patch.exposePrefix = body.exposePrefix;
    if (Array.isArray(body.exposeExempt))
      patch.exposeExempt = body.exposeExempt;
    if (typeof body.allowUnknown === "boolean")
      patch.allowUnknown = body.allowUnknown;
    if (typeof body.defaultMaxOutputTokens === "number")
      patch.defaultMaxOutputTokens = body.defaultMaxOutputTokens;
    if (typeof body.ssePingInterval === "number")
      patch.ssePingInterval = body.ssePingInterval;
    if (typeof body.requestLogRetentionDays === "number")
      patch.requestLogRetentionDays = body.requestLogRetentionDays;
    if (typeof body.debugLogging === "boolean")
      patch.debugLogging = body.debugLogging;
    if (typeof body.webToolsEnabled === "boolean")
      patch.webToolsEnabled = body.webToolsEnabled;
    if (typeof body.webToolsProvider === "string")
      patch.webToolsProvider = body.webToolsProvider;
    if (typeof body.webProviderBaseUrl === "string")
      patch.webProviderBaseUrl = body.webProviderBaseUrl;
    if (typeof body.webProviderApiKey === "string")
      patch.webProviderApiKey = body.webProviderApiKey;
    saveSettings(db, patch);
    router.reload();
    res.json(publicSettings());
  });

  r.post("/settings/password", requireAdmin, (req, res) => {
    try {
      const pw = (req.body as { password?: string })?.password;
      if (!pw) throw new Error("password required");
      changeAdminPassword(db, pw);
      res.json({ ok: true });
    } catch (e) {
      bad(res, e);
    }
  });

  return r;
}

// --- body parsers (coerce + strip unknown fields) --------------------------

// Absent fields stay `undefined` so partial PUTs (e.g. an inline enable
// toggle) never wipe unrelated columns; the repos merge undefined = keep.
// `requireCreate` enforces required fields on POST.

function parseProviderInput(
  body: unknown,
  requireCreate = false,
): ProviderInput {
  const b = (body || {}) as Record<string, unknown>;
  if (requireCreate) {
    if (!str(b.name)) throw new Error("name is required");
    if (!str(b.baseUrl)) throw new Error("baseUrl is required");
  }
  return {
    name: str(b.name) as string,
    baseUrl: str(b.baseUrl) as string,
    host:
      b.host === undefined ? undefined : b.host == null ? null : str(b.host),
    apiKeys: Array.isArray(b.apiKeys)
      ? (b.apiKeys as unknown[]).filter(
          (k): k is string => typeof k === "string",
        )
      : undefined,
    authScheme: b.authScheme as ProviderInput["authScheme"],
    extraHeaders:
      b.extraHeaders && typeof b.extraHeaders === "object"
        ? (b.extraHeaders as Record<string, string>)
        : undefined,
    retryAttempts: num(b.retryAttempts),
    retryIntervalMs: num(b.retryIntervalMs),
    requestTimeoutMs: num(b.requestTimeoutMs),
    tlsVerify: b.tlsVerify === undefined ? undefined : !!b.tlsVerify,
    enabled: b.enabled === undefined ? undefined : !!b.enabled,
    format:
      b.format === "anthropic" || b.format === "openai" ? b.format : undefined,
    endpoints: Array.isArray(b.endpoints)
      ? (b.endpoints as unknown[]).filter(
          (k): k is string => typeof k === "string",
        )
      : undefined,
    nativeConversion:
      b.nativeConversion === undefined ? undefined : !!b.nativeConversion,
    catalogId:
      b.catalogId === undefined
        ? undefined
        : b.catalogId == null
          ? null
          : str(b.catalogId),
    basePath: b.basePath === undefined ? undefined : (str(b.basePath) ?? ""),
    modelsPath:
      b.modelsPath === undefined ? undefined : (str(b.modelsPath) ?? ""),
    proxy:
      b.proxy === undefined ? undefined : b.proxy == null ? null : str(b.proxy),
    country:
      b.country === undefined
        ? undefined
        : b.country == null
          ? null
          : str(b.country),
  };
}

function parseModelInput(body: unknown, requireCreate = false): ModelInput {
  const b = (body || {}) as Record<string, unknown>;
  if (requireCreate && !str(b.alias)) throw new Error("alias is required");
  return {
    alias: str(b.alias) as string,
    displayName:
      b.displayName === undefined
        ? undefined
        : b.displayName == null
          ? null
          : str(b.displayName),
    contextWindow:
      b.contextWindow === undefined
        ? undefined
        : b.contextWindow == null
          ? null
          : num(b.contextWindow),
    maxOutputTokens:
      b.maxOutputTokens === undefined
        ? undefined
        : b.maxOutputTokens == null
          ? null
          : num(b.maxOutputTokens),
    enabled: b.enabled === undefined ? undefined : !!b.enabled,
    responsesNative:
      b.responsesNative === undefined ? undefined : !!b.responsesNative,
    type: b.type === "anthropic" || b.type === "openai" ? b.type : undefined,
    capabilities: b.capabilities as ModelCapabilities | undefined,
    providers: Array.isArray(b.providers)
      ? (b.providers as Array<Record<string, unknown>>).map((p) => ({
          providerId: str(p.providerId) ?? "",
          upstreamModel: str(p.upstreamModel) ?? "",
          enabled: p.enabled === undefined ? undefined : !!p.enabled,
          endpoint: p.endpoint == null ? null : str(p.endpoint),
          contextWindow:
            p.contextWindow == null ? null : num(p.contextWindow),
          maxOutputTokens:
            p.maxOutputTokens == null ? null : num(p.maxOutputTokens),
        }))
      : undefined,
  };
}

// Reference + auto-create: ensure every (provider, upstreamModel) a chain
// references exists in that provider's imported catalog. Missing ones are
// created with just their identity (metadata can be filled in later on the
// provider's models page). Idempotent via upsert.
function autoCreateImportedModels(db: DB, input: ModelInput): void {
  for (const link of input.providers ?? []) {
    if (!link.providerId || !link.upstreamModel) continue;
    upsertProviderModel(db, {
      providerId: link.providerId,
      upstreamId: link.upstreamModel,
    });
  }
}

// Coerce a raw transforms payload into ModelTransformConfig[]. Skips malformed
// entries defensively; unknown ids are tolerated (resolved/ignored at apply).
function parseTransformConfig(v: unknown): ModelTransformConfig[] {
  if (!Array.isArray(v)) return [];
  const out: ModelTransformConfig[] = [];
  for (const raw of v) {
    const t = raw as Record<string, unknown>;
    const id = str(t.id);
    const phase = t.phase === "response" ? "response" : "request";
    if (!id) continue;
    out.push({
      id,
      phase,
      params:
        t.params && typeof t.params === "object" && !Array.isArray(t.params)
          ? (t.params as Record<string, unknown>)
          : {},
    });
  }
  return out;
}

function parseUserInput(body: unknown, requireCreate = false): UserInput {
  const b = (body || {}) as Record<string, unknown>;
  if (requireCreate && !str(b.name)) throw new Error("name is required");
  return {
    name: str(b.name) as string,
    email:
      b.email === undefined ? undefined : b.email == null ? null : str(b.email),
    enabled: b.enabled === undefined ? undefined : !!b.enabled,
    notes:
      b.notes === undefined ? undefined : b.notes == null ? null : str(b.notes),
  };
}

function parseApiKeyInput(body: unknown): ApiKeyInput {
  const b = (body || {}) as Record<string, unknown>;
  return {
    name:
      b.name === undefined ? undefined : b.name == null ? null : str(b.name),
    userId:
      b.userId === undefined
        ? undefined
        : b.userId == null
          ? null
          : str(b.userId),
    tokensPerDay:
      b.tokensPerDay === undefined
        ? undefined
        : b.tokensPerDay == null || b.tokensPerDay === ""
          ? null
          : (num(b.tokensPerDay) ?? null),
    enabled: b.enabled === undefined ? undefined : !!b.enabled,
  };
}

// Trimmed string, or undefined when not a string (absent field).
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// --- provider connectivity test --------------------------------------------

interface ProviderLike {
  baseUrl: string;
  host: string | null;
  apiKeys: string[];
  authScheme: string;
  tlsVerify: boolean;
  extraHeaders: Record<string, string>;
  basePath?: string;
  modelsPath?: string;
  proxy?: string | null;
}

// GET {origin}{basePath}{modelsPath} with the provider's auth, preserving any
// path prefix (e.g. Gemini's /v1beta/openai/models). Routes through the
// provider's outbound proxy when one is configured.
function probeModels(p: ProviderLike): Promise<{
  status: number | null;
  body: string;
  ms: number;
  error?: string;
}> {
  const base = p.baseUrl.replace(/\/+$/, "");
  const basePath = p.basePath || "";
  const modelsPath = p.modelsPath || "/v1/models";
  const url = new URL(base + basePath + modelsPath);
  const isHttps = url.protocol === "https:";
  const transport = isHttps ? https : http;
  let proxyAgent: ReturnType<typeof agentFor>;
  try {
    proxyAgent = agentFor(p.proxy, isHttps);
  } catch (err) {
    return Promise.resolve({
      status: null,
      body: "",
      ms: 0,
      error: `bad proxy: ${(err as Error).message}`,
    });
  }
  const headers: Record<string, string> = {
    accept: "application/json",
    host: p.host || url.host,
    ...p.extraHeaders,
  };
  const key = p.apiKeys[0];
  if (key) {
    if (p.authScheme === "bearer" || p.authScheme === "both")
      headers.authorization = `Bearer ${key}`;
    if (p.authScheme === "xapikey" || p.authScheme === "both")
      headers["x-api-key"] = key;
  }
  const start = Date.now();
  return new Promise((resolve) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        method: "GET",
        path: url.pathname + url.search,
        headers,
        rejectUnauthorized: p.tlsVerify,
        ...(proxyAgent ? { agent: proxyAgent } : {}),
      },
      (upRes) => {
        const chunks: Buffer[] = [];
        upRes.on("data", (c) => chunks.push(c as Buffer));
        upRes.on("end", () =>
          resolve({
            status: upRes.statusCode ?? null,
            body: Buffer.concat(chunks).toString("utf8"),
            ms: Date.now() - start,
          }),
        );
      },
    );
    req.on("error", (err) =>
      resolve({
        status: null,
        body: "",
        ms: Date.now() - start,
        error: err.message,
      }),
    );
    req.setTimeout(15000, () => req.destroy(new Error("probe timeout")));
    req.end();
  });
}

async function fetchUpstreamModels(p: ProviderLike): Promise<string[]> {
  const res = await probeModels(p);
  try {
    const parsed = JSON.parse(res.body);
    const models: string[] = [];
    if (Array.isArray(parsed.data)) {
      for (const m of parsed.data) {
        if (m && typeof m.id === "string") models.push(m.id);
      }
    }
    return models.sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function testProvider(p: ProviderLike): Promise<{
  ok: boolean;
  status: number | null;
  ms: number;
  error?: string;
  sample?: string;
}> {
  const res = await probeModels(p);
  return {
    ok: !!res.status && res.status >= 200 && res.status < 400,
    status: res.status,
    ms: res.ms,
    error: res.error,
    sample: res.body.slice(0, 240) || undefined,
  };
}
