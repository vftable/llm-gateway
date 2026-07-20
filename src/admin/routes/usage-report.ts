// Per-provider + all-providers upstream key-usage reports (the /providers
// and /providers/:id/usage dashboards), built from each adapter's async
// keyUsage() seam.

import type { Database as DB } from "better-sqlite3";
import type { Provider, ProviderUsageReport } from "../../types";
import { adapterForProvider } from "../../providers";
import { listProviders } from "../../repo/providers";
import { listProviderKeys } from "../../repo/provider-keys";
import { maskKey, seedFromKey, makeUsageCtx } from "./provider-probe";

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
  const providerKeys = listProviderKeys(db, p.id);
  const rows = providerKeys.map((k) => ({
    key: k.credential,
    enabled: k.enabled,
    metadata: k.metadata,
  }));

  // Visibility gate: if the adapter doesn't report usage at all, skip the per-key
  // queries and return an empty, unsupported report. The dashboard drops these;
  // the per-provider view uses `supported` to show a "not reported" note. The
  // gate sees a representative key (the first row) so it can decide from config.
  const first = rows[0];
  const supported = adapter.supportsKeyUsage({
    provider: p,
    apiKey: first?.key ?? "",
    keyMetadata: first?.metadata ?? {},
    mask: first ? maskKey(first.key) : "",
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
    rows.map(async ({ key, enabled, metadata }) => {
      const mask = maskKey(key);
      try {
        const { windows, expiresAt, dummy, unavailable, message } =
          await adapter.keyUsage({
            provider: p,
            apiKey: key,
            keyMetadata: metadata,
            mask,
            enabled,
            seed: seedFromKey(key),
            ...makeUsageCtx(p),
          });
        if (dummy) anyDummy = true;
        return {
          keyMask: mask,
          enabled,
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
          windows: [],
          unavailable: true,
          message: `Usage query failed: ${(e as Error).message}`,
        };
      }
    }),
  );
  return {
    providerId: p.id,
    providerName: p.name,
    catalogId: p.catalogId,
    brand: adapter.brand,
    supported: true,
    dummy: anyDummy,
    keys,
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
  return reports.filter((r) => r.supported);
}
