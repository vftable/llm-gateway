// Step 1: pick a catalog template, grouped by provider family.

import { Loader2 } from "lucide-react";
import type { ProviderTemplate } from "@/lib/types";
import { ProviderIcon } from "@/components/model-icon";
import { groupByFamily } from "@/lib/provider-families";

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

  const groups = groupByFamily(templates, (t) => t.id);

  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <div key={g.label}>
          <div className="mb-2 flex items-center gap-2">
            {g.brand && (
              <ProviderIcon
                brand={g.brand}
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
