// Request-log repository. One row per proxied request, feeding the dashboard's
// activity feed and overview stats. Logs are pruned to a configurable retention
// window so the table stays bounded.

import type { Database as DB } from "better-sqlite3";
import type { RequestLog } from "../types";

// Canonical marker the engine stamps on the `error` of a gateway-generated
// "whole chain is temporarily rate-limited" 503 (see engine.ts
// finishChainExhausted). It's code-owned — never sourced from an upstream body
// — so matching on it reliably distinguishes a transient throttle from a real
// 5xx failure, WITHOUT coupling to the fact that 503 happens to be in
// RETRY_STATUS. The retry epoch (ms) is embedded so the row can show a
// countdown: `throttled:<epochMs>: <human reason>`.
export const THROTTLE_MARKER = "throttled:";

// Build the `error` string stored for a throttle 503. `retryAtMs` is the epoch
// ms when the soonest key frees up; `reason` is the operator-facing detail.
export function throttleLogError(retryAtMs: number, reason: string): string {
  return `${THROTTLE_MARKER}${Math.round(retryAtMs)}: ${reason}`;
}

// Parse a log row's (status, error) into throttle state. A row is "throttled"
// only when it's a 503 carrying the marker — a genuine upstream/gateway 5xx is
// never mistaken for one. Returns the retry epoch (ms) when present.
export function parseThrottle(
  status: number | null,
  error: string | null,
): { throttled: boolean; retryAt: number | null } {
  if (status !== 503 || !error || !error.startsWith(THROTTLE_MARKER))
    return { throttled: false, retryAt: null };
  const rest = error.slice(THROTTLE_MARKER.length);
  const ms = Number.parseInt(rest, 10);
  return { throttled: true, retryAt: Number.isFinite(ms) ? ms : null };
}

// SQL fragment identifying a throttle 503 row (marker-tagged). Shared by the
// dashboard aggregates so a throttle is uniformly excluded from error/5xx
// counts. `error` is the request_logs column (optionally aliased).
function throttleSql(col = "error"): string {
  return `(status = 503 AND ${col} LIKE '${THROTTLE_MARKER}%')`;
}

interface LogRow {
  id: number;
  ts: string;
  api_key_id: string | null;
  api_key_name: string | null;
  key_prefix: string | null;
  user_id: string | null;
  model: string | null;
  provider_id: string | null;
  provider_name: string | null;
  live_provider_name: string | null;
  upstream_model: string | null;
  upstream_key_mask: string | null;
  status: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  latency_ms: number | null;
  client: string | null;
  path: string | null;
  stream: number;
  error: string | null;
  debug_request: string | null;
  debug_response: string | null;
  cost_usd: number | null;
  catalog_id: string | null;
}

function mapLog(r: LogRow): RequestLog {
  return {
    id: r.id,
    ts: r.ts,
    apiKeyId: r.api_key_id,
    apiKeyName: r.api_key_name,
    // Live-joined masked key ("sk-…") so the feed never shows the internal
    // "key-…" id; falls back to the snapshot name then the id.
    keyPrefix: r.key_prefix,
    userId: r.user_id,
    model: r.model,
    providerId: r.provider_id,
    // Prefer the provider's CURRENT name; fall back to the row snapshot when
    // the provider was since deleted.
    providerName: r.live_provider_name ?? r.provider_name,
    upstreamModel: r.upstream_model,
    upstreamKeyMask: r.upstream_key_mask,
    status: r.status,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cachedTokens: r.cached_tokens,
    latencyMs: r.latency_ms,
    client: r.client,
    path: r.path,
    stream: !!r.stream,
    error: r.error,
    // Flag only — the heavy request/response blobs are fetched on demand via
    // getRequestLogDetail so the list stays light.
    hasDebug: !!(r.debug_request || r.debug_response),
    catalogId: r.catalog_id,
    costUsd: r.cost_usd,
    // A transient "whole chain rate-limited" 503 (not a real failure): the UI
    // badges it amber and shows the retry countdown instead of a red error.
    ...(() => {
      const t = parseThrottle(r.status, r.error);
      return t.throttled
        ? {
            throttled: true as const,
            ...(t.retryAt ? { retryAt: t.retryAt } : {}),
          }
        : {};
    })(),
  };
}

export interface InsertLogInput {
  apiKeyId: string | null;
  apiKeyName: string | null;
  userId: string | null;
  model: string | null;
  providerId: string | null;
  providerName: string | null;
  upstreamModel: string | null;
  upstreamKeyHash: string | null;
  upstreamKeyMask: string | null;
  status: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  latencyMs: number | null;
  client: string | null;
  path: string | null;
  stream: boolean;
  error: string | null;
  /** Distilled client request JSON for the debug view (null when disabled). */
  debugRequest: string | null;
  /** Distilled model response JSON for the debug view (null when disabled). */
  debugResponse: string | null;
  /** Estimated USD cost (null when pricing is not configured). */
  costUsd: number | null;
}

export function insertRequestLog(db: DB, input: InsertLogInput): void {
  db.prepare(
    `INSERT INTO request_logs
      (ts, api_key_id, api_key_name, user_id, model, provider_id, provider_name,
       upstream_model, upstream_key_hash, upstream_key_mask, status, input_tokens,
       output_tokens, cached_tokens, latency_ms, client, path, stream, error,
       debug_request, debug_response, cost_usd)
    VALUES (@ts, @api_key_id, @api_key_name, @user_id, @model, @provider_id, @provider_name,
      @upstream_model, @upstream_key_hash, @upstream_key_mask, @status, @input_tokens,
      @output_tokens, @cached_tokens, @latency_ms, @client, @path, @stream, @error,
      @debug_request, @debug_response, @cost_usd)`,
  ).run({
    ts: new Date().toISOString(),
    api_key_id: input.apiKeyId,
    api_key_name: input.apiKeyName,
    user_id: input.userId,
    model: input.model,
    provider_id: input.providerId,
    provider_name: input.providerName,
    upstream_model: input.upstreamModel,
    upstream_key_hash: input.upstreamKeyHash,
    upstream_key_mask: input.upstreamKeyMask,
    status: input.status,
    input_tokens: input.inputTokens,
    output_tokens: input.outputTokens,
    cached_tokens: input.cachedTokens,
    latency_ms: input.latencyMs,
    client: input.client,
    path: input.path,
    stream: input.stream ? 1 : 0,
    error: input.error,
    debug_request: input.debugRequest,
    debug_response: input.debugResponse,
    cost_usd: input.costUsd,
  });
}

// Fetch the captured request/response debug blobs for one log row. Kept out of
// the list query so the feed stays light; loaded on demand when a row expands.
export function getRequestLogDetail(
  db: DB,
  id: number,
): { request: string | null; response: string | null } | null {
  const row = db
    .prepare(
      "SELECT debug_request, debug_response FROM request_logs WHERE id = ?",
    )
    .get(id) as
    { debug_request: string | null; debug_response: string | null } | undefined;
  if (!row) return null;
  return { request: row.debug_request, response: row.debug_response };
}

export interface ListOpts {
  limit?: number;
  offset?: number;
  apiKeyId?: string;
  modelId?: string;
  providerId?: string;
  statusError?: boolean;
}

export function listRequestLogs(db: DB, opts: ListOpts = {}): RequestLog[] {
  // Conditions are written against the request_logs alias `rl` since the query
  // below joins providers + api_keys for live names.
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.apiKeyId) {
    conditions.push("rl.api_key_id = @apiKeyId");
    params.apiKeyId = opts.apiKeyId;
  }
  if (opts.modelId) {
    conditions.push("rl.model = @modelId");
    params.modelId = opts.modelId;
  }
  if (opts.providerId) {
    conditions.push("rl.provider_id = @providerId");
    params.providerId = opts.providerId;
  }
  if (opts.statusError) {
    conditions.push("(rl.status IS NULL OR rl.status >= 400)");
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.limit = opts.limit ?? 100;
  params.offset = opts.offset ?? 0;
  // Join live providers + api_keys so names/masked prefixes reflect the current
  // state, not the snapshot captured when the request was logged. The heavy
  // debug blobs are reduced to boolean presence flags here (loaded in full only
  // when a row is expanded) so the feed stays light.
  const rows = db
    .prepare(
      `SELECT rl.id, rl.ts, rl.api_key_id, rl.api_key_name, rl.user_id, rl.model,
              rl.provider_id, rl.provider_name, rl.upstream_model,
              rl.upstream_key_mask, rl.status, rl.input_tokens, rl.output_tokens,
              rl.cached_tokens, rl.latency_ms,
              rl.client, rl.path, rl.stream, rl.error,
              (rl.debug_request IS NOT NULL) AS debug_request,
              (rl.debug_response IS NOT NULL) AS debug_response,
              p.name AS live_provider_name, k.key_prefix AS key_prefix,
              rl.cost_usd AS cost_usd,
              p.catalog_id AS catalog_id
      FROM request_logs rl
      LEFT JOIN providers p ON p.id = rl.provider_id
       LEFT JOIN api_keys k ON k.id = rl.api_key_id
       ${where} ORDER BY rl.id DESC LIMIT @limit OFFSET @offset`,
    )
    .all(params) as LogRow[];
  return rows.map(mapLog);
}

export function countRequestLogs(db: DB): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM request_logs").get() as {
    c: number;
  };
  return row.c;
}

export function pruneOldLogs(db: DB, retentionDays: number): number {
  const r = db
    .prepare("DELETE FROM request_logs WHERE ts < date('now', ?)")
    .run(`-${retentionDays} days`);
  return r.changes;
}

// Delete request logs for maintenance/cleanup. `scope`:
//   - "errors": only failed rows (status null or >= 400)
//   - "all":    every row
// Returns the number of rows removed.
export function clearRequestLogs(db: DB, scope: "errors" | "all"): number {
  const sql =
    scope === "errors"
      ? "DELETE FROM request_logs WHERE status IS NULL OR status >= 400"
      : "DELETE FROM request_logs";
  return db.prepare(sql).run().changes;
}

export interface HopStat {
  providerId: string;
  upstreamModel: string;
  success: number;
  /** Non-2xx status (including null, e.g. a timeout that never got a response). */
  errors: number;
}

// Per-hop success/error counts for one exposed model, keyed by (providerId,
// upstreamModel) — the same identity a chain link routes through — so the
// chain editor can show each hop's own hit-rate. Same success/error split as
// the rest of the app: 2xx = success, everything else (incl. null = timeout,
// aborted, or a request that never reached the upstream) = error.
export function hopStats(db: DB, modelAlias: string): HopStat[] {
  const rows = db
    .prepare(
      `SELECT provider_id AS providerId, upstream_model AS upstreamModel,
         COALESCE(SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END), 0) AS success,
         COALESCE(SUM(CASE WHEN status IS NULL OR status >= 300 THEN 1 ELSE 0 END), 0) AS errors
       FROM request_logs
       WHERE model = @modelAlias AND provider_id IS NOT NULL AND upstream_model IS NOT NULL
       GROUP BY provider_id, upstream_model`,
    )
    .all({ modelAlias }) as HopStat[];
  return rows;
}

export interface KeyStat {
  credHash: string;
  success: number;
  /** Non-2xx status (including null, e.g. a timeout that never got a response). */
  errors: number;
}

// Per-key success/error counts for one provider, keyed by upstream_key_hash —
// the same cred_hash a provider_keys row is looked up by — so the key manager
// can show each credential's own hit-rate. Same success/error split as
// hopStats: 2xx = success, everything else (incl. null = timeout, aborted, or
// a request that never reached the upstream) = error.
export function keyStats(db: DB, providerId: string): KeyStat[] {
  const rows = db
    .prepare(
      `SELECT upstream_key_hash AS credHash,
         COALESCE(SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END), 0) AS success,
         COALESCE(SUM(CASE WHEN status IS NULL OR status >= 300 THEN 1 ELSE 0 END), 0) AS errors
       FROM request_logs
       WHERE provider_id = @providerId AND upstream_key_hash IS NOT NULL
       GROUP BY upstream_key_hash`,
    )
    .all({ providerId }) as KeyStat[];
  return rows;
}

// Most-recent request timestamp per key for one provider, keyed by
// upstream_key_hash (== provider_keys.cred_hash). Any logged request counts as
// a "use" — including a 429 — since the usage dashboard sorts/highlights by
// when a key was last exercised, not by whether the call succeeded. Returns a
// hash -> ISO-timestamp map; keys that never served a logged request are absent.
export function lastUsedByKey(db: DB, providerId: string): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT upstream_key_hash AS credHash, MAX(ts) AS lastUsedAt
       FROM request_logs
       WHERE provider_id = @providerId AND upstream_key_hash IS NOT NULL
       GROUP BY upstream_key_hash`,
    )
    .all({ providerId }) as Array<{ credHash: string; lastUsedAt: string }>;
  return new Map(rows.map((r) => [r.credHash, r.lastUsedAt]));
}

// --- Aggregated dashboard stats -------------------------------------------

export interface DashboardStats {
  requestsToday: number;
  requestsErrorToday: number;
  /** Gateway throttle 503s today (whole chain temporarily rate-limited) —
   *  transient, excluded from requestsErrorToday and the error rate. */
  throttledToday: number;
  tokensToday: number;
  errorRateToday: number;
  costUsdToday: number;
  byModel: Array<{
    model: string;
    requests: number;
    tokens: number;
    cached: number;
    costUsd: number;
  }>;
  byProvider: Array<{
    providerId: string;
    catalogId: string | null;
    provider: string;
    requests: number;
    tokens: number;
    costUsd: number;
  }>;
  statusBands: { success: number; clientError: number; serverError: number };
  p95LatencyMs: number | null;
}

export function dashboardStats(db: DB): DashboardStats {
  const today = new Date().toISOString().slice(0, 10);
  // A gateway throttle 503 (whole chain temporarily rate-limited) is a
  // transient, retryable condition, NOT a failure — exclude it from the error
  // rate and the 5xx band, and surface it in its own `throttledToday` count.
  const throttle = throttleSql();
  const agg = db
    .prepare(
      `SELECT
         COUNT(*) AS requests,
         COALESCE(SUM(CASE WHEN (status IS NULL OR status >= 400) AND NOT ${throttle} THEN 1 ELSE 0 END), 0) AS errors,
         COALESCE(SUM(CASE WHEN ${throttle} THEN 1 ELSE 0 END), 0) AS throttled,
        COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS tokens,
        COALESCE(SUM(COALESCE(cost_usd, 0)), 0) AS cost,
         COALESCE(SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END), 0) AS success,
         COALESCE(SUM(CASE WHEN status >= 400 AND status < 500 THEN 1 ELSE 0 END), 0) AS clientErr,
         COALESCE(SUM(CASE WHEN status >= 500 AND NOT ${throttle} THEN 1 ELSE 0 END), 0) AS serverErr
       FROM request_logs WHERE date(ts) = @today`,
    )
    .get({ today }) as {
    requests: number;
    errors: number;
    throttled: number;
    tokens: number;
    cost: number;
    success: number;
    clientErr: number;
    serverErr: number;
  };

  const byModel = db
    .prepare(
      `SELECT model, COUNT(*) AS requests,
         COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0) AS tokens,
         COALESCE(SUM(COALESCE(cached_tokens,0)),0) AS cached,
         COALESCE(SUM(COALESCE(cost_usd,0)),0) AS costUsd
       FROM request_logs WHERE date(ts) = @today AND model IS NOT NULL
       GROUP BY model ORDER BY requests DESC LIMIT 10`,
    )
    .all({ today }) as Array<{
    model: string;
    requests: number;
    tokens: number;
    cached: number;
    costUsd: number;
  }>;

  // Join the live providers table so a renamed provider shows its CURRENT name,
  // not the snapshot frozen into the log row. Falls back to the snapshot when
  // the provider was since deleted.
  const byProvider = db
    .prepare(
      `SELECT rl.provider_id AS providerId,
         COALESCE(p.name, rl.provider_name) AS provider,
         p.catalog_id AS catalogId,
         COUNT(*) AS requests,
        COALESCE(SUM(COALESCE(rl.input_tokens,0)+COALESCE(rl.output_tokens,0)),0) AS tokens,
        COALESCE(SUM(COALESCE(rl.cost_usd,0)),0) AS costUsd
       FROM request_logs rl
       LEFT JOIN providers p ON p.id = rl.provider_id
       WHERE date(rl.ts) = @today AND rl.provider_id IS NOT NULL
       GROUP BY rl.provider_id ORDER BY requests DESC LIMIT 10`,
    )
    .all({ today }) as Array<{
    providerId: string;
    catalogId: string | null;
    provider: string;
    requests: number;
    tokens: number;
    costUsd: number;
  }>;

  const p95Row = db
    .prepare(
      `SELECT latency_ms FROM request_logs
       WHERE date(ts) = @today AND latency_ms IS NOT NULL
       ORDER BY latency_ms`,
    )
    .all({ today }) as Array<{ latency_ms: number }>;
  let p95: number | null = null;
  if (p95Row.length) {
    // Nearest-rank p95: ceil(N * 0.95) as a 1-based rank -> 0-based index.
    const idx = Math.max(0, Math.ceil(p95Row.length * 0.95) - 1);
    p95 = p95Row[idx].latency_ms;
  }

  const req = agg.requests || 0;
  // Throttles aren't failures and aren't successes either — exclude them from
  // the error-rate denominator so a burst of rate-limiting doesn't distort the
  // rate in either direction.
  const rateDenom = req - (agg.throttled || 0);
  return {
    requestsToday: req,
    requestsErrorToday: agg.errors || 0,
    throttledToday: agg.throttled || 0,
    tokensToday: agg.tokens || 0,
    errorRateToday: rateDenom > 0 ? (agg.errors / rateDenom) * 100 : 0,
    costUsdToday: agg.cost || 0,
    byModel,
    byProvider,
    statusBands: {
      success: agg.success || 0,
      clientError: agg.clientErr || 0,
      serverError: agg.serverErr || 0,
    },
    p95LatencyMs: p95,
  };
}
