// Auth (login/check), overview/stats, and settings routes.

import type { AdminAuth } from "../../auth/admin-auth";
import {
  changeAdminPassword,
  login as adminLogin,
} from "../../auth/admin-auth";
import { dashboardStats } from "../../repo/request-logs";
import { totalUsageHistory, hourlyUsageHistory } from "../../repo/usage";
import { listProviders } from "../../repo/providers";
import { listModels } from "../../repo/models";
import { listApiKeys } from "../../repo/api-keys";
import { getSettings, saveSettings } from "../../repo/settings";
import { listWebProviders } from "../../web-tools/backends";
import type { Settings } from "../../types";
import type { RouteCtx } from "./types";
import { bad } from "./respond";

export function registerSettingsRoutes(ctx: RouteCtx, auth: AdminAuth): void {
  const { db, router, r, requireAdmin, broadcast } = ctx;

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
    broadcast(["settings", "overview"], "settings:update");
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
}
