// Step 4: import models — pick a subset of the discovered upstream models to
// import alongside the new provider.

import { Check } from "lucide-react";
import type { ProviderTestProbe, UpstreamModel } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn, fmtTokens } from "@/lib/utils";

export function ImportStep({
  probe,
  selected,
  onToggle,
  filter,
  setFilter,
  filtered,
  onAll,
  onNone,
}: {
  probe: ProviderTestProbe | null;
  selected: Set<string>;
  onToggle: (id: string) => void;
  filter: string;
  setFilter: (v: string) => void;
  filtered: UpstreamModel[];
  onAll: () => void;
  onNone: () => void;
}) {
  const models = probe?.models ?? [];
  if (models.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        No upstream models discovered. You can create the provider now and add
        models later from its detail view.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter models…"
          className="font-mono"
        />
        <Button variant="ghost" size="sm" onClick={onAll}>
          All
        </Button>
        <Button variant="ghost" size="sm" onClick={onNone}>
          None
        </Button>
      </div>
      <div className="text-[0.7rem] text-muted-foreground">
        {selected.size} of {models.length} selected — new aliases are imported
        disabled (enable the ones you want public on the Models page); existing
        ones gain this provider as a fallback.
      </div>
      <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-border p-1">
        {filtered.map((m) => {
          const on = selected.has(m.id);
          const meta = [
            m.contextWindow && `${fmtTokens(m.contextWindow)} ctx`,
            m.maxOutputTokens && `${fmtTokens(m.maxOutputTokens)} out`,
          ].filter(Boolean);
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => onToggle(m.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                on
                  ? "bg-primary/10 text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded border",
                  on
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border",
                )}
              >
                {on && <Check className="h-3 w-3" />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-mono">{m.id}</span>
                {(m.displayName || meta.length > 0) && (
                  <span className="truncate text-[0.7rem] text-muted-foreground/80">
                    {[m.displayName, ...meta].filter(Boolean).join(" · ")}
                  </span>
                )}
              </span>
              {m.capabilities && (
                <Badge variant="secondary" className="shrink-0 opacity-70">
                  caps
                </Badge>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
