// Provider key-usage page. A branded card per provider showing each API key's
// upstream quota windows — token AND request limits over any time window, fed by
// the provider adapter's async keyUsage() hook. Values are placeholder
// ("estimate") until an adapter wires a real upstream usage query. The refresh
// button (top-right) re-runs every adapter's keyUsage() live.
//
// Layout: a hand-rolled masonry — cards are sized to their own content (a
// provider with 1 key sits short; one with many keys runs tall), and are
// greedily packed into N independent flex columns (shortest-column-first, by
// an estimated weight) so columns stay visually balanced. Neither CSS
// alternative gets this right with only a handful of very unevenly sized
// cards: `columns-*` fills one column top-to-bottom before moving to the
// next (easily stranding two tall cards together while the rest sit short),
// and a plain `grid` forces every card in a row to share the row's height
// (sized to the tallest card), leaving dead space under the shorter ones.
// Independent columns avoid both.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { KeyRound, ArrowUpRight, RefreshCw, Clock } from "lucide-react";
import { api } from "@/lib/api";
import type {
  ProviderUsageReport,
  ProviderKeyUsage,
  ProviderKeyUsageWindow,
  UsageUnit,
} from "@/lib/types";
import {
  PageHeader,
  EmptyState,
  Pagination,
  TableSearch,
} from "@/components/shared";
import { ProviderIcon } from "@/components/model-icon";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, fmtNum, fmtTokens } from "@/lib/utils";

const KEYS_PER_PAGE = 10;

// Tracks how many masonry columns fit the viewport, mirroring the
// `sm`/`xl` Tailwind breakpoints (640px / 1280px) this page used as a CSS
// grid before. Re-evaluated on resize so dragging the window across a
// breakpoint re-balances the columns.
function useColumnCount(): number {
  const getCount = () =>
    window.innerWidth >= 1280 ? 3 : window.innerWidth >= 640 ? 2 : 1;
  const [count, setCount] = useState(getCount);
  useEffect(() => {
    const onResize = () => setCount(getCount());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return count;
}

// Rough rendered-height proxy for a provider card, used only to balance
// masonry columns — doesn't need to be pixel-accurate, just proportional.
// Mirrors ProviderUsageCard's structure: header, optional search bar, one
// KeyUsageBlock per visible key (paginated, so capped at KEYS_PER_PAGE), and
// pagination controls.
function estimateWeight(report: ProviderUsageReport): number {
  const HEADER = 70;
  const SEARCH = report.keys.length > KEYS_PER_PAGE ? 40 : 0;
  const PAGINATION = report.keys.length > KEYS_PER_PAGE ? 40 : 0;
  const visibleKeys = report.keys.slice(0, KEYS_PER_PAGE);
  const keysWeight = visibleKeys.reduce((sum, key) => {
    let w = 40; // key mask row + block padding
    if (key.message) w += 30;
    w += key.windows.length * 46;
    return sum + w;
  }, 0);
  return HEADER + SEARCH + PAGINATION + keysWeight;
}

// Greedily assigns each report to whichever column currently carries the
// least estimated weight (shortest-column-first bin packing), preserving
// each column's internal top-to-bottom order.
function packColumns(
  reports: ProviderUsageReport[],
  columnCount: number,
): ProviderUsageReport[][] {
  const columns: ProviderUsageReport[][] = Array.from(
    { length: columnCount },
    () => [],
  );
  const weights = new Array(columnCount).fill(0);
  for (const report of reports) {
    let shortest = 0;
    for (let i = 1; i < columnCount; i++) {
      if (weights[i] < weights[shortest]) shortest = i;
    }
    columns[shortest].push(report);
    weights[shortest] += estimateWeight(report);
  }
  return columns;
}

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

  const columnCount = useColumnCount();
  const columns = useMemo(
    () => (reports ? packColumns(reports, columnCount) : []),
    [reports, columnCount],
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
        <UsageSkeleton />
      ) : reports.length === 0 ? (
        <EmptyState msg="No providers yet. Add one to see its key usage." />
      ) : (
        <div className="flex items-start gap-4">
          {columns.map((col, i) => (
            <div key={i} className="flex min-w-0 flex-1 flex-col gap-4">
              {col.map((r) => (
                <ProviderUsageCard key={r.providerId} report={r} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function UsageSkeleton() {
  return (
    <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i} className="gap-4">
          <div className="flex items-center gap-2.5">
            <Skeleton className="size-8 shrink-0 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="h-2.5 w-1/3" />
            </div>
          </div>
          <Skeleton className="h-16 w-full rounded-lg" />
          {i % 2 === 0 && <Skeleton className="h-16 w-full rounded-lg" />}
        </Card>
      ))}
    </div>
  );
}

function ProviderUsageCard({ report }: { report: ProviderUsageReport }) {
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const filteredKeys = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return query
      ? report.keys.filter(
          (key) =>
            key.keyMask.toLowerCase().includes(query) ||
            key.message?.toLowerCase().includes(query),
        )
      : report.keys;
  }, [filter, report.keys]);
  const pageCount = Math.max(1, Math.ceil(filteredKeys.length / KEYS_PER_PAGE));
  const safePage = Math.min(page, pageCount - 1);
  const pageKeys = filteredKeys.slice(
    safePage * KEYS_PER_PAGE,
    (safePage + 1) * KEYS_PER_PAGE,
  );

  useEffect(() => setPage(0), [filter, report.keys.length]);

  return (
    <Card className="min-w-0 gap-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <ProviderIcon
            brand={report.catalogId}
            name={report.providerName}
            className="size-5 shrink-0"
          />
          <div className="min-w-0">
            <Link
              to={`/providers/${report.providerId}/keys`}
              className="flex min-w-0 items-center gap-1 text-sm font-semibold text-foreground hover:text-primary"
            >
              <span className="truncate">{report.providerName}</span>
              <ArrowUpRight className="h-3 w-3 shrink-0 opacity-50" />
            </Link>
            <div className="text-xs text-muted-foreground">
              {report.keys.length} recorded{" "}
              {report.keys.length === 1 ? "key" : "keys"}
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

      {report.keys.length > KEYS_PER_PAGE && (
        <TableSearch
          value={filter}
          onChange={setFilter}
          placeholder="Filter keys…"
          count={filter ? filteredKeys.length : undefined}
          total={filter ? report.keys.length : undefined}
          className="w-full sm:w-full"
        />
      )}

      {report.keys.length === 0 ? (
        <div className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
          <KeyRound className="h-3.5 w-3.5" />
          No recorded key usage yet.
        </div>
      ) : pageKeys.length === 0 ? (
        <EmptyState msg="No keys match this filter" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          {pageKeys.map((key) => (
            <KeyUsageBlock key={key.keyMask} usage={key} />
          ))}
        </div>
      )}

      <Pagination
        page={safePage}
        pageCount={pageCount}
        onChange={setPage}
        className="-mx-4 -mb-4 mt-auto px-4"
      />
    </Card>
  );
}

// Exported so the provider detail Keys tab can render the same per-key usage
// blocks inline (fed by the per-provider usage endpoint).
export function KeyUsageBlock({ usage }: { usage: ProviderKeyUsage }) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border/70 bg-muted/20 p-3 transition-colors",
        !usage.enabled && "opacity-60",
      )}
    >
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-x-2 gap-y-1",
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
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {usage.expiresAt && <ExpiryBadge expiresAt={usage.expiresAt} />}
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
        <div className="mb-2.5 text-xs leading-snug text-muted-foreground">
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
          <div className="text-xs text-muted-foreground">
            {usage.unavailable ? "Usage unavailable." : "No usage reported."}
          </div>
        )
      )}
    </div>
  );
}

// A key's own lifetime — distinct from a window's reset countdown. Tone
// ramps up as expiry approaches so an operator notices a dying credential
// before it fails requests: neutral when far off, amber inside a week,
// destructive inside a day or already expired.
function ExpiryBadge({ expiresAt }: { expiresAt: string }) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  const expired = ms <= 0;
  const day = 86_400_000;
  const variant =
    expired || ms < day
      ? "destructive"
      : ms < 7 * day
        ? "warning"
        : "secondary";
  return (
    <Badge
      variant={variant}
      className={cn(variant === "secondary" && "opacity-70")}
      title={new Date(expiresAt).toLocaleString()}
    >
      <Clock className="mr-1 h-2.5 w-2.5" />
      {/* relativeTime already reads naturally either direction:
          "expired 2d ago" / "expires in 6h". */}
      {expired ? "expired" : "expires"} {relativeTime(expiresAt)}
    </Badge>
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
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-foreground">{w.label}</span>
        <span className="tabular-nums text-muted-foreground">
          {w.unit === "percent" ? (
            <span className="font-mono text-foreground">{pct.toFixed(0)}%</span>
          ) : (
            <>
              <span className="font-mono text-foreground">
                {fmtUsage(w.used, w.unit)}
              </span>
              {" / "}
              <span className="font-mono">
                {fmtUsage(w.limit, w.unit)}
              </span>{" "}
              {w.unit}
            </>
          )}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border/60">
        <div
          className={cn("h-full rounded-full transition-all", tone)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
        <span className="tabular-nums">
          {w.unit === "percent"
            ? "Quota utilization"
            : `${pct.toFixed(0)}% used`}
        </span>
        {/* A one-shot balance (e.g. a prepaid credit grant) has no rolling
            reset — omit the line rather than showing a broken "resets —". */}
        {w.resetsAt && <span>resets {relativeTime(w.resetsAt)}</span>}
      </div>
    </div>
  );
}

// Compact "in 3h 42m" / "2d ago" relative time for an ISO timestamp, either
// direction. `now` for anything within a minute of the present. Hours carry
// minute precision (e.g. "4h 59m") so a countdown doesn't look frozen at "5h"
// for the better part of an hour; days stay whole (e.g. "2d") — sub-day
// precision doesn't matter once a window is a day-plus out.
function relativeTime(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "—";
  const past = ms <= 0;
  const abs = Math.abs(ms);
  const totalMin = Math.round(abs / 60000);
  if (totalMin < 1) return "now";
  let unit: string;
  if (totalMin < 60) {
    unit = `${totalMin}m`;
  } else if (totalMin < 24 * 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    unit = `${h}h ${m}m`;
  } else {
    unit = `${Math.round(totalMin / 60 / 24)}d`;
  }
  return past ? `${unit} ago` : `in ${unit}`;
}
