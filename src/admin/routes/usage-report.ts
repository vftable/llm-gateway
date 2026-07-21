// Per-provider + all-providers upstream key-usage reports (the /providers
// and /providers/:id/usage dashboards), built from each adapter's async
// keyUsage() seam.

import type { Database as DB } from "better-sqlite3";
import type { Provider, ProviderUsageReport } from "../../types";
import { adapterForProvider } from "../../providers";
import { listProviders } from "../../repo/providers";
import { getUnifiedUsage } from "../../repo/provider-key-usage";
import { listProviderKeys, maskProviderKey } from "../../repo/provider-keys";
import { seedFromKey, makeUsageCtx } from "./provider-probe";
import { KeyHealthStore } from "../../gateway/key-health";

// Build the usage report for ONE provider by asking its adapter for each key's
// windows (keys read from provider_keys table). The adapter keyUsage() is async
// (a real one queries the provider's usage endpoint), so we await every key in
// parallel; the raw key is passed to the adapter but masked before it reaches
// the response.
export async function buildUsageReport(
  p: Provider,
  db: DB,
): Promise<ProviderUsageReport> {
  const adapter = adapterForProvider(p);
  const healthStore = new KeyHealthStore(db);
  const providerKeys = listProviderKeys(db, p.id);
  const rows = providerKeys.map((k) => {
    const h = healthStore.snapshot(p.id, k.credHash);
    return {
      key: k.credential,
      enabled: k.enabled,
      metadata: k.metadata,
      keyHash: k.credHash,
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

  // Visibility gate: if the adapter doesn't report usage at all, skip the per-key
  // queries and return an empty, unsupported report. The dashboard drops these;
  // the per-provider view uses `supported` to show a "not reported" note. The
  // gate sees a representative key (the first row) so it can decide from config.
  const first = rows[0];
  const supported = adapter.supportsKeyUsage({
    provider: p,
    apiKey: first?.key ?? "",
    keyMetadata: first?.metadata ?? {},
    mask: first ? maskProviderKey(first.key) : "",
    enabled: first?.enabled ?? true,
    seed: first ? seedFromKey(first.key) : 0,
    ...makeUsageCtx(p),
  });
  if (!supported) {
    return {
      providerId: p.id,
      providerName: p.name,
      catalogId: p.catalogId,
      brand: adapter.brand,
      supported: false,
      dummy: false,
      keys: [],
    };
  }

  let anyDummy = false;
  const keys = await Promise.all(
    rows.map(async ({ key, enabled, metadata, keyHash, health }) => {
      const mask = maskProviderKey(key);
      try {
        const { windows, expiresAt, dummy, unavailable, message } =
          await adapter.keyUsage({
            provider: p,
            apiKey: key,
            keyMetadata: metadata,
            mask,
            enabled,
            seed: seedFromKey(key),
            unifiedUsage: getUnifiedUsage(db, p.id, keyHash),
            ...makeUsageCtx(p),
          });
        if (dummy) anyDummy = true;
        return {
          keyMask: mask,
          enabled,
          health,
          windows,
          ...(expiresAt ? { expiresAt } : {}),
          ...(unavailable ? { unavailable: true } : {}),
          ...(message ? { message } : {}),
        };
      } catch (e) {
        // An adapter's live query threw — surface it as an unavailable key with
        // the error detail rather than failing the whole page.
        return {
          keyMask: mask,
          enabled,
          health,
          windows: [],
          unavailable: true,
          message: `Usage query failed: ${(e as Error).message}`,
        };
      }
    }),
  );
  const visibleKeys = keys.filter((key) => {
    // Dead/auth-failed keys don't belong in the usage dashboard — they are shown
    // in the provider Keys table where operators manage credentials. Rate-limited
    // keys stay visible because their usage/quota windows are still relevant.
    if (key.health?.dead) return false;
    const hasUsageHealthState = !!key.health?.rateLimitedUntil;
    if (!key.enabled && !hasUsageHealthState) return false;
    // Passive Claude Code usage is meaningful only after a real request has
    // produced unified quota headers; hide unrecorded rows to avoid clutter unless
    // the row explains an active rate-limit cooldown.
    if (
      p.catalogId === "claude-code" &&
      key.unavailable &&
      !hasUsageHealthState
    )
      return false;
    return true;
  });
  return {
    providerId: p.id,
    providerName: p.name,
    catalogId: p.catalogId,
    brand: adapter.brand,
    supported: true,
    dummy: anyDummy,
    keys: visibleKeys,
  };
}

// All providers' reports (the /providers/usage dashboard), built in parallel.
// Providers whose adapter doesn't report usage (supportsKeyUsage() = false) are
// omitted entirely — the dashboard only lists providers that have something to
// show, rather than a wall of empty cards.
export async function buildUsageReports(
  db: DB,
): Promise<ProviderUsageReport[]> {
  const reports = await Promise.all(
    listProviders(db).map((p) => buildUsageReport(p, db)),
  );
  return reports.filter((r) => r.supported && r.keys.length > 0);
}
