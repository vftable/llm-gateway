// Step 1: pick a catalog template, grouped by provider family.

import { Loader2 } from "lucide-react";
import type { ProviderTemplate } from "@/lib/types";
import { ProviderIcon } from "@/components/model-icon";

interface Family {
  label: string;
  brand: string | null;
  ids: Set<string>;
}

const FAMILIES: Family[] = [
  {
    label: "Anthropic",
    brand: "anthropic",
    ids: new Set(["anthropic", "claude-code"]),
  },
  { label: "OpenAI", brand: "openai", ids: new Set(["openai"]) },
  { label: "DeepSeek", brand: "deepseek", ids: new Set(["deepseek"]) },
  {
    label: "Google",
    brand: "gemini",
    ids: new Set(["google-gemini"]),
  },
  { label: "NVIDIA", brand: "nvidia", ids: new Set(["nvidia-nim"]) },
  { label: "OpenRouter", brand: "openrouter", ids: new Set(["openrouter"]) },
  { label: "Z.ai", brand: "zai", ids: new Set(["glm-coding"]) },
  { label: "NewAPI", brand: "newapi", ids: new Set(["newapi"]) },
  { label: "OpenCode", brand: "opencode", ids: new Set(["opencode"]) },
  { label: "Xiaomi", brand: "mimo", ids: new Set(["xiaomi-mimo"]) },
];

function groupTemplates(
  templates: ProviderTemplate[],
): Array<{ family: Family | null; label: string; items: ProviderTemplate[] }> {
  const claimed = new Set<string>();
  const groups: Array<{
    family: Family | null;
    label: string;
    items: ProviderTemplate[];
  }> = [];

  for (const fam of FAMILIES) {
    const items = templates.filter((t) => fam.ids.has(t.id));
    if (items.length) {
      groups.push({ family: fam, label: fam.label, items });
      items.forEach((t) => claimed.add(t.id));
    }
  }

  const custom = templates.filter((t) => !claimed.has(t.id));
  if (custom.length)
    groups.push({ family: null, label: "Custom", items: custom });

  return groups;
}

export function PickStep({
  templates,
  onPick,
}: {
  templates: ProviderTemplate[] | null;
  onPick: (t: ProviderTemplate) => void;
}) {
  if (!templates)
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading catalog…
      </div>
    );

  const groups = groupTemplates(templates);

  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <div key={g.label}>
          <div className="mb-2 flex items-center gap-2">
            {g.family?.brand && (
              <ProviderIcon
                brand={g.family.brand}
                className="size-4 text-muted-foreground"
              />
            )}
            <h3 className="text-sm font-medium text-muted-foreground">
              {g.label}
            </h3>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {g.items.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onPick(t)}
                className="group flex items-start gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary/60 hover:bg-accent/40"
              >
                <ProviderIcon
                  brand={t.brand}
                  name={t.label}
                  className="mt-0.5 size-5"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {t.label}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-[0.7rem] leading-snug text-muted-foreground">
                    {t.blurb}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
