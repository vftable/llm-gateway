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
import type { GatewayPipeline } from "../gateway/pipeline";
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
} from "../repo/request-logs";
import { vacuumFreePages } from "../db";
import { getSettings, saveSettings } from "../repo/settings";
import type { ModelCapabilities, Settings } from "../shared/types";

export function adminRouter(
  db: DB,
  logger: Logger,
  pipeline: GatewayPipeline,
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
  r.get("/providers", requireAdmin, (_req, res) => res.json(listProviders(db)));

  r.post("/providers", requireAdmin, (req, res) => {
    try {
      const input = parseProviderInput(req.body, true);
      const p = createProvider(db, input);
      pipeline.reload();
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
      pipeline.reload();
      res.json(p);
    } catch (e) {
      bad(res, e);
    }
  });

  r.delete("/providers/:id", requireAdmin, (req, res) => {
    if (!deleteProvider(db, String(req.params.id)))
      return res.status(404).json({ error: { message: "not found" } });
    pipeline.reload();
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

  // --- models (with fallback chain) ---
  r.get("/models", requireAdmin, (_req, res) => res.json(listModels(db)));

  r.post("/models", requireAdmin, (req, res) => {
    try {
      const input = parseModelInput(req.body, true);
      const m = createModel(db, input);
      pipeline.reload();
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
      const m = updateModel(
        db,
        String(req.params.id),
        parseModelInput(req.body),
      );
      if (!m) return res.status(404).json({ error: { message: "not found" } });
      pipeline.reload();
      res.json(m);
    } catch (e) {
      bad(res, e);
    }
  });

  r.delete("/models/:id", requireAdmin, (req, res) => {
    if (!deleteModel(db, String(req.params.id)))
      return res.status(404).json({ error: { message: "not found" } });
    pipeline.reload();
    res.status(204).end();
  });

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
      pipeline.reload();
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
    pipeline.reload();
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
    saveSettings(db, patch);
    pipeline.reload();
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
        }))
      : undefined,
  };
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
}

// GET {baseUrl}/v1/models with the provider's auth, preserving any path
// prefix in baseUrl (e.g. https://host/api -> /api/v1/models).
function probeModels(
  p: ProviderLike,
): Promise<{
  status: number | null;
  body: string;
  ms: number;
  error?: string;
}> {
  const base = p.baseUrl.replace(/\/+$/, "");
  const url = new URL(base + "/v1/models");
  const transport = url.protocol === "https:" ? https : http;
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
