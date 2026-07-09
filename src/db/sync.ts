// config.json -> database sync.
//
// config.json is the single configuration file. Besides bootstrap values it
// may carry seed data: one upstream provider, model mappings, and gateway API
// keys. On every boot this module compares a hash of that seed section with
// the hash recorded from the previous sync; when it changed, the data is
// merged into the database:
//
//   - the config provider is upserted (created once, then updated in place)
//   - each model mapping is upserted by alias, keeping its link to the config
//     provider; models the admin created in the dashboard are never touched
//   - each gateway key is ingested once; config-managed keys removed from the
//     file are deleted (dashboard-created keys are never touched)
//   - global model settings (prefix, exposePrefix, ...) are written
//
// Bookkeeping (which provider/models/keys the config manages, and the last
// sync hash) lives in the settings table under `configSync*` keys.

import type { Database as DB } from "better-sqlite3";
import { sha256, type ConfigJson } from "../config";
import { createProvider, getProvider, updateProvider } from "../repo/providers";
import {
  createModel,
  deleteModel,
  getModelByAlias,
  updateModel,
  type ModelInput,
} from "../repo/models";
import { createApiKey, deleteApiKey } from "../repo/api-keys";
import { saveSettings } from "../repo/settings";
import { DEFAULT_CAPABILITIES, type ModelCapabilities } from "../types";

interface ConfigMapping {
  upstream: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  enabled?: boolean;
  responses?: boolean;
  type?: string;
  capabilities?: ModelCapabilities;
}

export interface SyncResult {
  changed: boolean;
  providerId: string | null;
  models: number;
  modelsRemoved: number;
  keys: number;
  keysRemoved: number;
}

const NO_CHANGE: SyncResult = {
  changed: false,
  providerId: null,
  models: 0,
  modelsRemoved: 0,
  keys: 0,
  keysRemoved: 0,
};

// Raw settings-table access for internal bookkeeping keys that are not part
// of the public Settings shape.
function getMeta<T>(db: DB, key: string): T | null {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

function setMeta(db: DB, key: string, value: unknown): void {
  db.prepare(
    "INSERT INTO settings(key, value) VALUES(?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, JSON.stringify(value));
}

// Normalise the different historical gatewayApiKeys shapes (array of strings,
// single string, or { key: { tokensPerDay } } object) into one list.
function normaliseKeys(
  gk: unknown,
): Array<{ key: string; tokensPerDay: number | null }> {
  const out: Array<{ key: string; tokensPerDay: number | null }> = [];
  const push = (key: unknown, tokensPerDay?: number | null) => {
    if (typeof key === "string" && key.length > 0)
      out.push({ key, tokensPerDay: tokensPerDay ?? null });
  };
  if (Array.isArray(gk)) for (const k of gk) push(k);
  else if (typeof gk === "string") push(gk);
  else if (gk && typeof gk === "object") {
    for (const [k, v] of Object.entries(gk)) {
      push(k, (v as { tokensPerDay?: number } | null)?.tokensPerDay);
    }
  }
  return out;
}

export function syncFromConfig(db: DB, cfg: ConfigJson): SyncResult {
  const m = cfg.models || {};
  const hasSeed =
    !!cfg.upstream ||
    !!cfg.gatewayApiKeys ||
    !!cfg.webTools ||
    Object.keys(m.mappings ?? {}).length > 0;
  if (!hasSeed) return NO_CHANGE;

  // Only the seed-relevant slice participates in the change hash, so edits to
  // bootstrap values (port, paths) don't trigger a re-sync.
  const seedSlice = {
    upstream: cfg.upstream ?? null,
    upstreamApiKey: cfg.upstreamApiKey ?? null,
    upstreamTlsVerify: cfg.upstreamTlsVerify ?? null,
    gatewayApiKeys: cfg.gatewayApiKeys ?? null,
    webTools: cfg.webTools ?? null,
    models: m,
  };
  const hash = sha256(JSON.stringify(seedSlice));
  if (getMeta<string>(db, "configSyncHash") === hash) return NO_CHANGE;

  const result: SyncResult = { ...NO_CHANGE, changed: true };

  const tx = db.transaction(() => {
    // --- settings ---
    const wt = cfg.webTools;
    // Accept both the new generic keys and the legacy firecrawl* aliases.
    const wtEnabled = wt?.enabled ?? wt?.firecrawl;
    const wtBaseUrl = wt?.baseUrl ?? wt?.firecrawlBaseUrl;
    const wtApiKey = wt?.apiKey ?? wt?.firecrawlApiKey;
    saveSettings(db, {
      ...(m.prefix !== undefined && { modelPrefix: m.prefix }),
      ...(m.exposePrefix !== undefined && { exposePrefix: m.exposePrefix }),
      ...(m.exposeExempt !== undefined && { exposeExempt: m.exposeExempt }),
      ...(m.allowUnknown !== undefined && { allowUnknown: m.allowUnknown }),
      ...(m.defaultMaxOutputTokens !== undefined && {
        defaultMaxOutputTokens: m.defaultMaxOutputTokens,
      }),
      ...(wtEnabled !== undefined && { webToolsEnabled: wtEnabled }),
      ...(wt?.provider !== undefined && { webToolsProvider: wt.provider }),
      ...(wtBaseUrl !== undefined && { webProviderBaseUrl: wtBaseUrl }),
      ...(wtApiKey !== undefined && { webProviderApiKey: wtApiKey }),
    });

    // --- provider ---
    let providerId = getMeta<string>(db, "configSyncProviderId");
    if (providerId && !getProvider(db, providerId)) providerId = null;
    // Adopt the provider created by the pre-2.0 first-run seeder so upgrading
    // doesn't duplicate it.
    if (!providerId && getProvider(db, "9router")) providerId = "9router";

    if (cfg.upstream) {
      const baseUrl = cfg.upstream.replace(/\/+$/, "");
      const apiKeys = cfg.upstreamApiKey ? [cfg.upstreamApiKey] : [];
      const tlsVerify = cfg.upstreamTlsVerify !== false;
      if (providerId) {
        updateProvider(db, providerId, { baseUrl, apiKeys, tlsVerify });
      } else {
        const p = createProvider(db, {
          id: "config-upstream",
          name: "Config Upstream",
          baseUrl,
          apiKeys,
          authScheme: "both",
          tlsVerify,
          retryAttempts: 1,
          enabled: true,
        });
        providerId = p.id;
      }
      setMeta(db, "configSyncProviderId", providerId);
    }
    result.providerId = providerId;

    // --- models (upsert by alias; delete config-managed strays) ---
    const restricted = new Set(m.restricted ?? []);
    const managedBefore = new Set(
      getMeta<string[]>(db, "configSyncModelAliases") ?? [],
    );
    const managedNow: string[] = [];

    for (const [alias, rawMapping] of Object.entries(m.mappings ?? {})) {
      const mapping: ConfigMapping =
        typeof rawMapping === "string"
          ? { upstream: rawMapping }
          : (rawMapping as ConfigMapping);
      const input: ModelInput = {
        alias,
        displayName: mapping.displayName ?? null,
        contextWindow: mapping.contextWindow ?? null,
        maxOutputTokens: mapping.maxOutputTokens ?? null,
        responsesNative: mapping.responses === true,
        type:
          mapping.type ?? (alias.startsWith("claude") ? "anthropic" : "openai"),
        capabilities: mapping.capabilities ?? DEFAULT_CAPABILITIES,
        enabled: restricted.has(alias) ? false : mapping.enabled !== false,
        ...(providerId && {
          providers: [{ providerId, upstreamModel: mapping.upstream }],
        }),
      };
      const existing = getModelByAlias(db, alias);
      if (existing) updateModel(db, existing.id, input);
      else createModel(db, input);
      managedNow.push(alias);
      result.models++;
    }

    for (const alias of managedBefore) {
      if (managedNow.includes(alias)) continue;
      const stray = getModelByAlias(db, alias);
      if (stray) {
        deleteModel(db, stray.id);
        result.modelsRemoved++;
      }
    }
    setMeta(db, "configSyncModelAliases", managedNow);

    // --- gateway keys (ingest by hash; delete config-managed strays) ---
    const keys = normaliseKeys(cfg.gatewayApiKeys);
    const managedIdsBefore = new Set(
      getMeta<string[]>(db, "configSyncKeyIds") ?? [],
    );
    const managedIdsNow: string[] = [];

    const byHash = db.prepare("SELECT id FROM api_keys WHERE key_hash = ?");
    const setQuota = db.prepare(
      "UPDATE api_keys SET tokens_per_day = ? WHERE id = ?",
    );
    for (const { key, tokensPerDay } of keys) {
      const row = byHash.get(sha256(key)) as { id: string } | undefined;
      if (row) {
        // Keep quota in sync only for keys this sync created earlier.
        if (managedIdsBefore.has(row.id)) setQuota.run(tokensPerDay, row.id);
        managedIdsNow.push(row.id);
      } else {
        const created = createApiKey(db, { tokensPerDay }, key);
        managedIdsNow.push(created.id);
        result.keys++;
      }
    }

    for (const id of managedIdsBefore) {
      if (managedIdsNow.includes(id)) continue;
      if (deleteApiKey(db, id)) result.keysRemoved++;
    }
    setMeta(db, "configSyncKeyIds", managedIdsNow);

    setMeta(db, "configSyncHash", hash);
  });
  tx();

  return result;
}
