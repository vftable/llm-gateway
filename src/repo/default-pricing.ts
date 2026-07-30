// Stock default pricing for well-known models across providers - a reference
// table an operator can use to pre-fill a model's Prompt/Completion/Cached
// rates instead of looking them up by hand. Mirrors the shape of
// formats/anthropic/stock-models.ts (a static array + a tolerant lookup by
// alias), and the wire shape of repo/pricing.ts's ModelPricing so the admin
// UI/API can drop a matched entry straight into the same form fields.
//
// This is a REFERENCE only - it is never read by the request path or
// computeCostUsd. An operator (or the model editor's "Use default" button)
// copies a match into the model's own `model_pricing` row via upsertPricing;
// nothing here is authoritative until it's been copied in.
//
// Sourced from each provider's public pricing page; verify before relying on
// it for billing-critical decisions, and expect drift - providers change
// prices without notice more often than this table gets updated.

export interface DefaultModelPricing {
  /** Model id as the provider names it (matched tolerantly, see below). */
  id: string;
  /** Human label for the picker UI. */
  label: string;
  /** Catalog brand id (matches a src/providers/catalog/*.ts entry's `brand`),
   *  for grouping/iconography in the UI. */
  brand: string;
  promptPer1m: number;
  completionPer1m: number;
  /** Omitted when the provider publishes no cache-hit discount rate - the
   *  model editor's own placeholder ("defaults to prompt rate") already
   *  covers that case, so this table doesn't need to repeat promptPer1m here. */
  cachedPer1m?: number;
}

export const DEFAULT_MODEL_PRICING: DefaultModelPricing[] = [
  // --- Anthropic ------------------------------------------------------------
  // https://platform.claude.com/docs/en/about-claude/pricing
  {
    id: "claude-fable-5",
    label: "Claude Fable 5",
    brand: "anthropic",
    promptPer1m: 10,
    completionPer1m: 50,
    cachedPer1m: 1,
  },
  {
    id: "claude-mythos-5",
    label: "Claude Mythos 5",
    brand: "anthropic",
    promptPer1m: 10,
    completionPer1m: 50,
    cachedPer1m: 1,
  },
  {
    id: "claude-opus-5",
    label: "Claude Opus 5",
    brand: "anthropic",
    promptPer1m: 5,
    completionPer1m: 25,
    cachedPer1m: 0.5,
  },
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    brand: "anthropic",
    promptPer1m: 5,
    completionPer1m: 25,
    cachedPer1m: 0.5,
  },
  {
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7",
    brand: "anthropic",
    promptPer1m: 5,
    completionPer1m: 25,
    cachedPer1m: 0.5,
  },
  {
    id: "claude-opus-4-6",
    label: "Claude Opus 4.6",
    brand: "anthropic",
    promptPer1m: 5,
    completionPer1m: 25,
    cachedPer1m: 0.5,
  },
  {
    id: "claude-opus-4-5",
    label: "Claude Opus 4.5",
    brand: "anthropic",
    promptPer1m: 5,
    completionPer1m: 25,
    cachedPer1m: 0.5,
  },
  {
    // Standard pricing (post Aug 31 2026 introductory window) - the durable
    // rate, so a stock reference doesn't silently go stale the day the promo
    // ends. See the source doc's note for the $2/$10 introductory rate.
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    brand: "anthropic",
    promptPer1m: 3,
    completionPer1m: 15,
    cachedPer1m: 0.3,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    brand: "anthropic",
    promptPer1m: 3,
    completionPer1m: 15,
    cachedPer1m: 0.3,
  },
  {
    id: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    brand: "anthropic",
    promptPer1m: 3,
    completionPer1m: 15,
    cachedPer1m: 0.3,
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    brand: "anthropic",
    promptPer1m: 1,
    completionPer1m: 5,
    cachedPer1m: 0.1,
  },

  // --- OpenAI -----------------------------------------------------------
  // https://openai.com/api/pricing, https://openai.com/index/gpt-5-6/
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    brand: "openai",
    promptPer1m: 5,
    completionPer1m: 30,
    cachedPer1m: 0.5,
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    brand: "openai",
    promptPer1m: 2,
    completionPer1m: 12,
    cachedPer1m: 0.2,
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    brand: "openai",
    promptPer1m: 0.2,
    completionPer1m: 1.2,
    cachedPer1m: 0.02,
  },

  // --- DeepSeek -----------------------------------------------------------
  // https://api-docs.deepseek.com/quick_start/pricing/ (official; cache-hit
  // rate is a genuine subset price, not a flat discount fraction).
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    brand: "deepseek",
    promptPer1m: 0.435,
    completionPer1m: 0.87,
    cachedPer1m: 0.003625,
  },
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    brand: "deepseek",
    promptPer1m: 0.14,
    completionPer1m: 0.28,
    cachedPer1m: 0.0028,
  },

  // --- Z.AI / GLM -----------------------------------------------------------
  // https://docs.z.ai/guides/overview/pricing
  {
    id: "glm-5.2",
    label: "GLM-5.2",
    brand: "zai",
    promptPer1m: 1.4,
    completionPer1m: 4.4,
    cachedPer1m: 0.26,
  },

  // --- xAI / Grok -----------------------------------------------------------
  // https://docs.x.ai/developers/pricing (short-context tier; long-context
  // >=200k prompt tokens roughly doubles input/output and drops cached to
  // $0.30 - not modeled here, this is the standard-tier rate).
  {
    id: "grok-4.5",
    label: "Grok 4.5",
    brand: "xai",
    promptPer1m: 2,
    completionPer1m: 6,
    cachedPer1m: 0.3,
  },

  // --- Google / Gemini --------------------------------------------------
  // https://ai.google.dev/gemini-api/docs/pricing (<=200k prompt-token tier;
  // the >200k tier roughly doubles both rates).
  {
    id: "gemini-3.1-pro",
    label: "Gemini 3.1 Pro",
    brand: "gemini",
    promptPer1m: 2,
    completionPer1m: 12,
  },
];

// Full reference list, for a picker UI. Function form (not the raw const)
// matches this app's other catalog-listing seams (e.g. listProviderTemplates,
// listTransformDefs) - a stable read accessor, even though today it's a
// simple array copy.
export function listDefaultModelPricing(): DefaultModelPricing[] {
  return DEFAULT_MODEL_PRICING;
}

const DATE_SUFFIX = /-\d{8}$/;

// Find a default-pricing entry for a gateway alias or upstream model id.
// Matches the exact id first, then tolerates a date-suffix mismatch in either
// direction (same convention as stockAnthropicModel), so e.g. an alias of
// "claude-sonnet-5-20260629" still finds the "claude-sonnet-5" entry.
export function defaultPricingFor(
  idOrAlias: string,
): DefaultModelPricing | undefined {
  const exact = DEFAULT_MODEL_PRICING.find((m) => m.id === idOrAlias);
  if (exact) return exact;
  const base = idOrAlias.replace(DATE_SUFFIX, "");
  return DEFAULT_MODEL_PRICING.find(
    (m) => m.id === base || m.id.replace(DATE_SUFFIX, "") === base,
  );
}
