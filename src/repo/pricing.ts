// Model pricing repository. One row per exposed-model alias, carrying
// per-million-token rates for prompt, completion, and cached tokens.

import type { Database as DB } from "better-sqlite3";

export interface ModelPricing {
  alias: string;
  promptPer1m: number | null;
  completionPer1m: number | null;
  cachedPer1m: number | null;
  updatedAt: string;
}

interface PricingRow {
  alias: string;
  prompt_per_1m: number | null;
  completion_per_1m: number | null;
  cached_per_1m: number | null;
  updated_at: string;
}

function mapPricing(r: PricingRow): ModelPricing {
  return {
    alias: r.alias,
    promptPer1m: r.prompt_per_1m,
    completionPer1m: r.completion_per_1m,
    cachedPer1m: r.cached_per_1m,
    updatedAt: r.updated_at,
  };
}

export function getPricingByAlias(
  db: DB,
  alias: string,
): ModelPricing | null {
  const row = db
    .prepare("SELECT * FROM model_pricing WHERE alias = ?")
    .get(alias) as PricingRow | undefined;
  return row ? mapPricing(row) : null;
}

export function pricingMapByAliases(
  db: DB,
  aliases: string[],
): Map<string, ModelPricing> {
  if (aliases.length === 0) return new Map();
  const placeholders = aliases.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM model_pricing WHERE alias IN (${placeholders})`)
    .all(...aliases) as PricingRow[];
  return new Map(rows.map((r) => [r.alias, mapPricing(r)]));
}

export function upsertPricing(
  db: DB,
  p: Omit<ModelPricing, "updatedAt">,
): ModelPricing {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO model_pricing (alias, prompt_per_1m, completion_per_1m, cached_per_1m, updated_at)
     VALUES (@alias, @promptPer1m, @completionPer1m, @cachedPer1m, @now)
     ON CONFLICT(alias) DO UPDATE SET
       prompt_per_1m = @promptPer1m,
       completion_per_1m = @completionPer1m,
       cached_per_1m = @cachedPer1m,
       updated_at = @now`,
  ).run({
    alias: p.alias,
    promptPer1m: p.promptPer1m,
    completionPer1m: p.completionPer1m,
    cachedPer1m: p.cachedPer1m,
    now,
  });
  return { ...p, updatedAt: now };
}

export function deletePricing(db: DB, alias: string): boolean {
  const r = db.prepare("DELETE FROM model_pricing WHERE alias = ?").run(alias);
  return r.changes > 0;
}

// Compute per-request dollar cost from actual tokens. Cached tokens are
// billed at cachedPer1m when set, otherwise at promptPer1m (OpenAI convention).
// Any missing required rate makes the whole row's cost null (no partial estimates).
export function computeCostUsd(
  pricing: ModelPricing | null | undefined,
  inputTokens: number | null,
  outputTokens: number | null,
  cachedTokens: number | null,
): number | null {
  if (!pricing) return null;
  const { promptPer1m, completionPer1m, cachedPer1m } = pricing;
  if (promptPer1m == null || completionPer1m == null) return null;

  const cachedRate = cachedPer1m ?? promptPer1m;
  const cached = cachedTokens ?? 0;
  const inputBillable = Math.max(0, (inputTokens ?? 0) - cached);
  const output = outputTokens ?? 0;

  return (inputBillable * promptPer1m + cached * cachedRate + output * completionPer1m) / 1_000_000;
}

// --- unit smoke test ---

if (process.argv[1]?.endsWith("pricing.ts")) {
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`FAIL: ${msg}`);
  };

  const full: ModelPricing = {
    alias: "test",
    promptPer1m: 0.15,
    completionPer1m: 0.6,
    cachedPer1m: 0.075,
    updatedAt: "",
  };
  // Full pricing: 1000 input, 500 output, 200 cached
  // inputBillable = 1000 - 200 = 800
  // cost = (800 * 0.15 + 200 * 0.075 + 500 * 0.6) / 1e6 = (120 + 15 + 300) / 1e6 = 0.000435
  const c1 = computeCostUsd(full, 1000, 500, 200);
  assert(c1 !== null && Math.abs(c1 - 0.000435) < 1e-9, `full pricing: got ${c1}`);

  // Null pricing → null
  const c2 = computeCostUsd(null, 1000, 500, 200);
  assert(c2 === null, "null pricing should return null");

  // Partial pricing (only prompt) → null
  const partial: ModelPricing = { ...full, completionPer1m: null };
  const c3 = computeCostUsd(partial, 1000, 500, 200);
  assert(c3 === null, "partial pricing should return null");

  // Cache fallback: cachedPer1m null → billed at promptPer1m
  const noCache: ModelPricing = { ...full, cachedPer1m: null };
  const c4 = computeCostUsd(noCache, 1000, 500, 200);
  // inputBillable = 800, cached = 200 billed at 0.15
  // cost = (800 * 0.15 + 200 * 0.15 + 500 * 0.6) / 1e6 = (120 + 30 + 300) / 1e6 = 0.00045
  assert(c4 !== null && Math.abs(c4 - 0.00045) < 1e-9, `cache fallback: got ${c4}`);

  // Null tokens → 0 cost with valid pricing
  const c5 = computeCostUsd(full, null, null, null);
  assert(c5 === 0, `null tokens with valid pricing: got ${c5}`);

  console.log("All pricing tests passed.");
}
