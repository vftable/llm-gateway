// Daily token-usage repository (replaces the old JSON-file usage tracker).
//
// Each (api_key, UTC day) pair has a single integer counter. Day rollover is
// implicit — a new day key starts at zero. Quota enforcement reads today's row
// and optimistically debits projected tokens before proxying; the engine later
// reconciles with the upstream-reported actual usage (subtract estimate, add
// actual).

import type { Database as DB } from "better-sqlite3";
import type { KeyUsage } from "../types";

export function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function nextUtcMidnight(): Date {
  const d = new Date();
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1),
  );
}

export function getUsage(db: DB, apiKeyId: string): KeyUsage {
  const day = utcDay();
  const row = db
    .prepare("SELECT tokens, day FROM usage WHERE api_key_id = ? AND day = ?")
    .get(apiKeyId, day) as { tokens: number; day: string } | undefined;
  return row ?? { tokens: 0, day };
}

export function addUsage(db: DB, apiKeyId: string, tokens: number): void {
  if (!apiKeyId || tokens <= 0) return;
  const day = utcDay();
  db.prepare(
    `INSERT INTO usage (api_key_id, day, tokens) VALUES (@id, @day, @tokens)
     ON CONFLICT(api_key_id, day) DO UPDATE SET tokens = tokens + @tokens`,
  ).run({ id: apiKeyId, day, tokens });
}

export function subtractUsage(db: DB, apiKeyId: string, tokens: number): void {
  if (!apiKeyId || tokens <= 0) return;
  const day = utcDay();
  db.prepare(
    `UPDATE usage SET tokens = MAX(0, tokens - @tokens)
     WHERE api_key_id = @id AND day = @day`,
  ).run({ id: apiKeyId, day, tokens });
}

// Today's usage joined with the API key for the dashboard's "keys" view.
export interface UsageRow {
  apiKeyId: string;
  keyName: string | null;
  keyPrefix: string;
  userName: string | null;
  limit: number | null;
  used: number;
  day: string;
}

export function listUsageToday(db: DB): UsageRow[] {
  const day = utcDay();
  const rows = db
    .prepare(
      `SELECT k.id AS apiKeyId, k.name AS keyName, k.key_prefix AS keyPrefix,
              u.name AS userName, k.tokens_per_day AS \`limit\`,
              COALESCE(usg.tokens, 0) AS used, @day AS day
       FROM api_keys k
       LEFT JOIN users u ON u.id = k.user_id
       LEFT JOIN usage usg ON usg.api_key_id = k.id AND usg.day = @day
       ORDER BY used DESC, k.created_at DESC`,
    )
    .all({ day }) as UsageRow[];
  return rows;
}

// Daily token totals across all keys for the last `days` days (oldest first),
// for the usage-over-time chart. Zero-filled: every day in the window is
// present (missing days -> 0) so the chart always shows a full, evenly-spaced
// series of exactly `days` points rather than collapsing to whatever days
// happened to have traffic.
export function totalUsageHistory(
  db: DB,
  days = 14,
): Array<{ day: string; tokens: number }> {
  const rows = db
    .prepare(
      `SELECT day, SUM(tokens) AS tokens FROM usage
       WHERE day >= date('now', ?)
       GROUP BY day`,
    )
    .all(`-${days - 1} days`) as Array<{ day: string; tokens: number | null }>;
  const byDay = new Map(rows.map((r) => [r.day, r.tokens ?? 0]));

  const out: Array<{ day: string; tokens: number }> = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const key = d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    out.push({ day: key, tokens: byDay.get(key) ?? 0 });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// Hourly token totals for the last `hours` hours (oldest first), for the
// dashboard's real-time chart. Sourced from request_logs (the per-request
// record carries a timestamp; the daily `usage` counter does not), summing
// actual input+output tokens. Zero-filled so every hour bucket is present.
export function hourlyUsageHistory(
  db: DB,
  hours = 24,
): Array<{ hour: string; tokens: number }> {
  // ts is stored as an ISO-8601 UTC string, so the first 13 chars
  // (YYYY-MM-DDTHH) are the UTC hour bucket.
  const since = new Date();
  since.setUTCMinutes(0, 0, 0);
  since.setUTCHours(since.getUTCHours() - (hours - 1));
  const rows = db
    .prepare(
      `SELECT substr(ts, 1, 13) AS hour,
              COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0) AS tokens
       FROM request_logs
       WHERE ts >= @since
       GROUP BY substr(ts, 1, 13)`,
    )
    .all({ since: since.toISOString() }) as Array<{
    hour: string;
    tokens: number | null;
  }>;
  const byHour = new Map(rows.map((r) => [r.hour, r.tokens ?? 0]));

  const out: Array<{ hour: string; tokens: number }> = [];
  const d = new Date(since);
  for (let i = 0; i < hours; i++) {
    const key = d.toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)
    out.push({ hour: key, tokens: byHour.get(key) ?? 0 });
    d.setUTCHours(d.getUTCHours() + 1);
  }
  return out;
}

export function totalUsageToday(db: DB): number {
  const day = utcDay();
  const row = db
    .prepare("SELECT COALESCE(SUM(tokens), 0) AS t FROM usage WHERE day = ?")
    .get(day) as { t: number };
  return row.t;
}

// --- Per (key, model, provider) breakdown ---------------------------------
//
// Records the token cost of each request attributed to the model alias the
// client requested and the provider the request actually resolved to (after
// fallback). Powers the dashboard's "what did this key resolve to" view —
// e.g. a key using gpt-5.5 shows the token count and the provider chosen.

export interface UsageBreakdownRow {
  apiKeyId: string;
  model: string;
  providerId: string | null;
  providerName: string | null;
  tokens: number;
  requests: number;
  costUsd: number;
}

export function addBreakdown(
  db: DB,
  apiKeyId: string,
  model: string,
  providerId: string | null,
  tokens: number,
  costUsd: number | null = null,
): void {
  if (!apiKeyId || tokens <= 0) return;
  const day = utcDay();
  const cost = costUsd ?? 0;
  // One request per call: seed requests=1 on insert, +1 on every conflict so the
  // counter tracks request volume alongside the token total for this group.
  db.prepare(
    `INSERT INTO usage_breakdown (api_key_id, day, model, provider_id, tokens, requests, cost_usd)
     VALUES (@id, @day, @model, @provider, @tokens, 1, @cost)
     ON CONFLICT(api_key_id, day, model, provider_id)
     DO UPDATE SET tokens = tokens + @tokens, requests = requests + 1, cost_usd = cost_usd + @cost`,
  ).run({ id: apiKeyId, day, model, provider: providerId, tokens, cost });
}

// Breakdown for a single key for today (or a given day), grouped by model +
// provider. Ordered by tokens desc.
export function breakdownForKey(
  db: DB,
  apiKeyId: string,
  day: string = utcDay(),
): UsageBreakdownRow[] {
  return db
    .prepare(
      `SELECT b.api_key_id AS apiKeyId, b.model AS model,
              b.provider_id AS providerId, p.name AS providerName,
              SUM(b.tokens) AS tokens, SUM(b.requests) AS requests,
              COALESCE(SUM(b.cost_usd), 0) AS costUsd
       FROM usage_breakdown b LEFT JOIN providers p ON p.id = b.provider_id
       WHERE b.api_key_id = @id AND b.day = @day
       GROUP BY b.model, b.provider_id
       ORDER BY tokens DESC`,
    )
    .all({ id: apiKeyId, day }) as UsageBreakdownRow[];
}

// Breakdown across ALL keys for today: rows of {key, model, provider, tokens,
// requests}, with the key identity attached. Used by the Usage page top table.
export interface FullBreakdownRow extends UsageBreakdownRow {
  keyName: string | null;
  keyPrefix: string;
  userName: string | null;
}

export function fullBreakdownToday(
  db: DB,
  day: string = utcDay(),
): FullBreakdownRow[] {
  return db
    .prepare(
      `SELECT b.api_key_id AS apiKeyId, k.name AS keyName, k.key_prefix AS keyPrefix,
              u.name AS userName, b.model AS model,
              b.provider_id AS providerId, p.name AS providerName,
              SUM(b.tokens) AS tokens, SUM(b.requests) AS requests,
              COALESCE(SUM(b.cost_usd), 0) AS costUsd
       FROM usage_breakdown b
       LEFT JOIN api_keys k ON k.id = b.api_key_id
       LEFT JOIN users u ON u.id = k.user_id
       LEFT JOIN providers p ON p.id = b.provider_id
       WHERE b.day = @day
       GROUP BY b.api_key_id, b.model, b.provider_id
       ORDER BY tokens DESC`,
    )
    .all({ day }) as FullBreakdownRow[];
}

// Aggregate "what did requests for model X resolve to" — which providers and
// how many tokens. Answers "if the user uses gpt-5.5 show what provider it
// resolved to".
export interface ModelResolutionRow {
  model: string;
  providerId: string | null;
  providerName: string | null;
  tokens: number;
  requests: number;
  costUsd: number;
}

export function modelResolution(
  db: DB,
  model: string,
  day: string = utcDay(),
): ModelResolutionRow[] {
  return db
    .prepare(
      `SELECT b.model AS model, b.provider_id AS providerId, p.name AS providerName,
              SUM(b.tokens) AS tokens, SUM(b.requests) AS requests,
              COALESCE(SUM(b.cost_usd), 0) AS costUsd
       FROM usage_breakdown b LEFT JOIN providers p ON p.id = b.provider_id
       WHERE b.day = @day AND b.model = @model
       GROUP BY b.provider_id
       ORDER BY tokens DESC`,
    )
    .all({ day, model }) as ModelResolutionRow[];
}

// --- Maintenance: rebuild counters from the request log --------------------
//
// `usage` and `usage_breakdown` are running counters mutated live as requests
// settle. If they ever drift (e.g. rows written by an older buggy build, or a
// crash between the reserve and the settle), request_logs remains the ground
// truth: one row per request with the actual input/output tokens. This
// recomputes both counters from those rows so all dashboard views re-converge.

export interface RebuildResult {
  days: number;
  usageRows: number;
  breakdownRows: number;
  tokens: number;
}

// Rebuild the usage counters from request_logs. When `day` is given, only that
// UTC day is rebuilt; otherwise every day present in the logs is rebuilt. Only
// successful (2xx) requests with a known key contribute, matching how the live
// settle path attributes usage. Runs in a single transaction so the counters
// are never observed half-rebuilt.
export function rebuildUsageFromLogs(db: DB, day?: string): RebuildResult {
  const result: RebuildResult = {
    days: 0,
    usageRows: 0,
    breakdownRows: 0,
    tokens: 0,
  };
  const dayFilter = day ? "AND date(ts) = @day" : "";
  const tx = db.transaction(() => {
    // Wipe the counters we're about to recompute (scoped to the day when set).
    if (day) {
      db.prepare("DELETE FROM usage WHERE day = @day").run({ day });
      db.prepare("DELETE FROM usage_breakdown WHERE day = @day").run({ day });
    } else {
      db.prepare("DELETE FROM usage").run();
      db.prepare("DELETE FROM usage_breakdown").run();
    }

    // Per (key, day) totals -> usage.
    const usageRows = db
      .prepare(
        `SELECT api_key_id AS apiKeyId, date(ts) AS day,
                COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0) AS tokens
         FROM request_logs
         WHERE api_key_id IS NOT NULL AND status >= 200 AND status < 300 ${dayFilter}
         GROUP BY api_key_id, date(ts)
         HAVING tokens > 0`,
      )
      .all(day ? { day } : {}) as Array<{
      apiKeyId: string;
      day: string;
      tokens: number;
    }>;
    const insUsage = db.prepare(
      "INSERT OR REPLACE INTO usage (api_key_id, day, tokens) VALUES (@apiKeyId, @day, @tokens)",
    );
    const days = new Set<string>();
    for (const r of usageRows) {
      insUsage.run(r);
      result.usageRows++;
      result.tokens += r.tokens;
      days.add(r.day);
    }

    // Per (key, day, model, provider) totals -> usage_breakdown.
    const bdRows = db
      .prepare(
        `SELECT api_key_id AS apiKeyId, date(ts) AS day, model,
                provider_id AS providerId,
                COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0) AS tokens,
                COUNT(*) AS requests,
                COALESCE(SUM(COALESCE(cost_usd,0)),0) AS costUsd
         FROM request_logs
         WHERE api_key_id IS NOT NULL AND model IS NOT NULL
               AND status >= 200 AND status < 300 ${dayFilter}
         GROUP BY api_key_id, date(ts), model, provider_id
         HAVING tokens > 0`,
      )
      .all(day ? { day } : {}) as Array<{
      apiKeyId: string;
      day: string;
      model: string;
      providerId: string | null;
      tokens: number;
      requests: number;
      costUsd: number;
    }>;
    const insBd = db.prepare(
      `INSERT OR REPLACE INTO usage_breakdown (api_key_id, day, model, provider_id, tokens, requests, cost_usd)
       VALUES (@apiKeyId, @day, @model, @providerId, @tokens, @requests, @costUsd)`,
    );
    for (const r of bdRows) {
      insBd.run(r);
      result.breakdownRows++;
    }

    result.days = day ? 1 : days.size;
  });
  tx();
  return result;
}
