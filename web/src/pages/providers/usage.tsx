// Provider key-usage page. A branded card per provider showing each API key's
// upstream quota windows — token AND request limits over any time window, fed by
// the provider adapter's async keyUsage() hook. Values are placeholder
// ("estimate") until an adapter wires a real upstream usage query. The refresh
// button (top-right) re-runs every adapter's keyUsage() live.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { KeyRound, ArrowUpRight, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type {
  ProviderUsageReport,
  ProviderKeyUsage,
  ProviderKeyUsageWindow,
  UsageUnit,
} from "@/lib/types";
import { PageHeader, CardGridSkeleton, EmptyState } from "@/components/shared";
import { ProviderIcon } from "@/components/model-icon";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, fmtNum, fmtTokens } from "@/lib/utils";

export default function ProviderUsage() {
  const [reports, setReports] = useState<ProviderUsageReport[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Refresh pulls live usage from each provider adapter (its async keyUsage()).
  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setReports(await api.providerUsage());
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totalKeys = useMemo(
    () => (reports ?? []).reduce((n, r) => n + r.keys.length, 0),
    [reports],
  );

  return (
    <div>
      <PageHeader
        title="Provider Usage"
        desc="Upstream token + request quota per API key, reported live by each provider"
        meta={
          reports && (
            <Badge variant="secondary">
              {totalKeys} {totalKeys === 1 ? "key" : "keys"}
            </Badge>
          )
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={refreshing}
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", refreshing && "animate-spin")}
            />
            Refresh
          </Button>
        }
      />

      {!reports ? (
        <CardGridSkeleton count={6} className="lg:grid-cols-2 xl:grid-cols-3" />
      ) : reports.length === 0 ? (
        <EmptyState msg="No providers yet. Add one to see its key usage." />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {reports.map((r) => (
            <ProviderUsageCard key={r.providerId} report={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderUsageCard({ report }: { report: ProviderUsageReport }) {
  return (
    <Card className="gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <ProviderIcon
            brand={report.catalogId}
            name={report.providerName}
            className="size-5"
          />
          <div className="min-w-0">
            <Link
              to={`/providers/${report.providerId}/keys`}
              className="flex items-center gap-1 truncate text-sm font-semibold text-foreground hover:text-primary"
            >
              <span className="truncate">{report.providerName}</span>
              <ArrowUpRight className="h-3 w-3 shrink-0 opacity-50" />
            </Link>
            <div className="text-[0.65rem] text-muted-foreground">
              {report.keys.length} {report.keys.length === 1 ? "key" : "keys"}
            </div>
          </div>
        </div>
        {report.dummy && (
          <Badge
            variant="secondary"
            className="shrink-0 opacity-70"
            title="Placeholder data — this provider does not yet report real upstream usage"
          >
            estimate
          </Badge>
        )}
      </div>

      {report.keys.length === 0 ? (
        <div className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
          <KeyRound className="h-3.5 w-3.5" />
          No keys configured.
        </div>
      ) : (
        <div className="space-y-3">
          {report.keys.map((k, i) => (
            <KeyUsageBlock key={i} usage={k} />
          ))}
        </div>
      )}
    </Card>
  );
}

// Exported so the provider detail Keys tab can render the same per-key usage
// blocks inline (fed by the per-provider usage endpoint).
export function KeyUsageBlock({ usage }: { usage: ProviderKeyUsage }) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border/70 bg-muted/20 p-3",
        !usage.enabled && "opacity-60",
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-2",
          usage.message ? "mb-1" : "mb-2.5",
        )}
      >
        <span
          className={cn(
            "truncate font-mono text-xs text-foreground",
            !usage.enabled && "line-through",
          )}
        >
          {usage.keyMask}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {usage.unavailable && (
            <Badge variant="secondary" className="opacity-70">
              Unavailable
            </Badge>
          )}
          {!usage.enabled && (
            <Badge variant="secondary" className="opacity-70">
              off
            </Badge>
          )}
        </span>
      </div>
      {usage.message && (
        <div className="mb-2.5 text-[0.65rem] leading-snug text-muted-foreground">
          {usage.message}
        </div>
      )}
      {usage.windows.length > 0 ? (
        <div className="space-y-3">
          {usage.windows.map((w) => (
            <UsageBar key={w.id} window={w} />
          ))}
        </div>
      ) : (
        !usage.message && (
          <div className="text-[0.65rem] text-muted-foreground">
            {usage.unavailable ? "Usage unavailable." : "No usage reported."}
          </div>
        )
      )}
    </div>
  );
}

// Requests are plain counts; tokens/credits read better abbreviated (1.2M).
function fmtUsage(n: number, unit: UsageUnit): string {
  return unit === "requests" ? fmtNum(n) : fmtTokens(n);
}

function UsageBar({ window: w }: { window: ProviderKeyUsageWindow }) {
  const pct = w.limit > 0 ? Math.min(100, (w.used / w.limit) * 100) : 0;
  // Warn/critical color as the window fills.
  const tone =
    pct >= 90 ? "bg-destructive" : pct >= 70 ? "bg-amber-500" : "bg-primary";
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[0.7rem]">
        <span className="font-medium text-foreground">{w.label}</span>
        <span className="tabular-nums text-muted-foreground">
          <span className="font-mono text-foreground">
            {fmtUsage(w.used, w.unit)}
          </span>
          {" / "}
          <span className="font-mono">{fmtUsage(w.limit, w.unit)}</span>{" "}
          {w.unit}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border/60">
        <div
          className={cn("h-full rounded-full transition-all", tone)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-[0.6rem] text-muted-foreground">
        <span className="tabular-nums">{pct.toFixed(0)}% used</span>
        <span>resets {relativeTime(w.resetsAt)}</span>
      </div>
    </div>
  );
}

// Compact "in 3h" / "in 2d" relative time for a future ISO timestamp.
function relativeTime(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "now";
  const min = Math.round(ms / 60000);
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `in ${hr}h`;
  const d = Math.round(hr / 24);
  return `in ${d}d`;
}
