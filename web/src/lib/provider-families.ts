// Single source of truth for "which branded family does this catalog id
// belong to" — used to group both catalog TEMPLATES (add-provider wizard's
// pick step) and live provider ROWS (the Providers page) by vendor, with a
// matching icon. Add a provider to the backend catalog
// (src/providers/catalog/<name>.ts + registry.ts) and it appears grouped
// here automatically once its id is added below; until then it falls into
// the catch-all "Custom" group `groupByFamily` always appends last.
//
// Deliberately excludes the generic escape-hatch adapters (openai-compatible,
// anthropic-compatible, proxy) — those SHOULD land in "Custom", they aren't a
// vendor family.

export interface ProviderFamily {
  label: string;
  /** Brand key resolved by the web brand-icon catalog (@/components/model-icon). */
  brand: string;
  /** Catalog ids (ProviderTemplate.id / Provider.catalogId) in this family. */
  ids: readonly string[];
}

// Display order == the order groups render in, both here and on /providers.
export const PROVIDER_FAMILIES: readonly ProviderFamily[] = [
  { label: "Anthropic", brand: "anthropic", ids: ["anthropic", "claude-code"] },
  { label: "OpenAI", brand: "openai", ids: ["openai"] },
  { label: "DeepSeek", brand: "deepseek", ids: ["deepseek"] },
  { label: "Google", brand: "gemini", ids: ["google-gemini"] },
  { label: "NVIDIA", brand: "nvidia", ids: ["nvidia-nim"] },
  { label: "OpenRouter", brand: "openrouter", ids: ["openrouter"] },
  { label: "Z.ai", brand: "zai", ids: ["glm-coding"] },
  { label: "Ollama", brand: "ollama", ids: ["ollama", "ollama-cloud"] },
  { label: "NewAPI", brand: "newapi", ids: ["newapi"] },
  { label: "OpenCode", brand: "opencode", ids: ["opencode", "opencode-go"] },
  { label: "Xiaomi", brand: "mimo", ids: ["xiaomi-mimo"] },
  { label: "Qwen", brand: "qwen", ids: ["qwencloud"] },
  { label: "Cline", brand: "cline", ids: ["clinepass"] },
  { label: "MiniMax", brand: "minimax", ids: ["minimax"] },
  { label: "xAI", brand: "xai", ids: ["xai"] },
];

export interface FamilyGroup<T> {
  label: string;
  brand: string | null;
  items: T[];
}

/**
 * Groups `items` by PROVIDER_FAMILIES, in family display order, then appends
 * a trailing "Custom" group (brand: null) for anything unclaimed — generic
 * escape-hatch adapters (openai-compatible, anthropic-compatible, proxy) and
 * any provider not yet added to PROVIDER_FAMILIES above.
 */
export function groupByFamily<T>(
  items: T[],
  getCatalogId: (item: T) => string | null | undefined,
): FamilyGroup<T>[] {
  const claimed = new Set<T>();
  const groups: FamilyGroup<T>[] = [];

  for (const family of PROVIDER_FAMILIES) {
    const matched = items.filter(
      (item) =>
        !claimed.has(item) && family.ids.includes(getCatalogId(item) ?? ""),
    );
    if (matched.length) {
      groups.push({ label: family.label, brand: family.brand, items: matched });
      matched.forEach((item) => claimed.add(item));
    }
  }

  const rest = items.filter((item) => !claimed.has(item));
  if (rest.length) groups.push({ label: "Custom", brand: null, items: rest });

  return groups;
}
