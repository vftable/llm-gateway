// Import picker (right-side sheet): discover upstream models and bulk-import
// a selected subset, with their reported metadata carried along.

import { useEffect, useMemo, useState } from "react";
import { Plus, Check, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Provider, UpstreamModel } from "@/lib/types";
import { EmptyState } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { fmtTokens, plural, cn } from "@/lib/utils";

export function ImportSheet({
  provider,
  existing,
  onClose,
  onImported,
}: {
  provider: Provider;
  existing: Set<string>;
  onClose: () => void;
  onImported: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [upstream, setUpstream] = useState<UpstreamModel[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .upstreamModels(provider.id)
      .then((r) => {
        setUpstream(r.models);
        if (r.error) toast.error(r.error);
      })
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setLoading(false));
  }, [provider.id]);

  const filtered = useMemo(
    () =>
      upstream.filter((m) =>
        (m.id + " " + (m.displayName ?? ""))
          .toLowerCase()
          .includes(filter.toLowerCase()),
      ),
    [upstream, filter],
  );

  // Any upstream model carries metadata worth surfacing (beyond a bare id)?
  const anyRich = useMemo(
    () =>
      upstream.some(
        (m) => m.displayName || m.contextWindow || m.maxOutputTokens,
      ),
    [upstream],
  );

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const run = async () => {
    setBusy(true);
    try {
      let created = 0;
      const byId = new Map(upstream.map((m) => [m.id, m]));
      for (const upstreamId of selected) {
        if (existing.has(upstreamId)) continue;
        // Import WITH the discovered metadata so context/max-out/capabilities
        // land on the row instead of coming in blank.
        const m = byId.get(upstreamId);
        await api.createProviderModel(provider.id, {
          upstreamId,
          displayName: m?.displayName ?? null,
          contextWindow: m?.contextWindow ?? null,
          maxOutputTokens: m?.maxOutputTokens ?? null,
          capabilities: m?.capabilities ?? null,
        });
        created++;
      }
      toast.success(plural(created, "model") + " imported");
      onImported();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Import from {provider.name}</SheetTitle>
          <SheetDescription>
            Pick upstream models to add to this provider's catalog.
            {anyRich &&
              " Context window, max output, and capabilities are imported with each."}
          </SheetDescription>
        </SheetHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Fetching upstream
            models…
          </div>
        ) : upstream.length === 0 ? (
          <EmptyState msg="No upstream models discovered for this provider" />
        ) : (
          <>
            <div className="mt-4 flex items-center gap-2">
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter…"
                className="font-mono"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setSelected(
                    new Set(
                      upstream
                        .filter((m) => !existing.has(m.id))
                        .map((m) => m.id),
                    ),
                  )
                }
              >
                All new
              </Button>
            </div>
            <div className="scrollbar-thin mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto">
              {filtered.map((m) => {
                const have = existing.has(m.id);
                const on = selected.has(m.id);
                // Compact metadata line: display name + context/max-out when the
                // upstream reported them (rich providers), else just the id.
                const meta = [
                  m.contextWindow && `${fmtTokens(m.contextWindow)} ctx`,
                  m.maxOutputTokens && `${fmtTokens(m.maxOutputTokens)} out`,
                ].filter(Boolean);
                return (
                  <button
                    key={m.id}
                    type="button"
                    disabled={have}
                    onClick={() => toggle(m.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                      have
                        ? "cursor-not-allowed text-muted-foreground/50"
                        : on
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
                      <Badge
                        variant="secondary"
                        className="shrink-0 opacity-70"
                        title="Capabilities reported by the provider"
                      >
                        caps
                      </Badge>
                    )}
                    {have && (
                      <Badge variant="secondary" className="shrink-0">
                        imported
                      </Badge>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Button variant="outline" onClick={onClose}>
                <X className="h-3.5 w-3.5" /> Cancel
              </Button>
              <Button onClick={run} disabled={busy || selected.size === 0}>
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                Import {selected.size || ""}
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
