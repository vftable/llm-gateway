// Provider key-usage page. A branded card per provider showing each API key's
// upstream quota windows — token AND request limits over any time window, fed by
// the provider adapter's async keyUsage() hook. Values are placeholder
// ("estimate") until an adapter wires a real upstream usage query. The refresh
// button (top-right) re-runs every adapter's keyUsage() live.
//
// Layout: a CSS-columns "bento" masonry — cards are sized to their own content
// (a provider with 1 key sits short; one with many keys runs tall) and flow
// into whichever column has room next, instead of a strict row grid where
// every card in a row is stretched to match the tallest. Column-balancing is
// native to `columns-*` (no JS masonry library needed); each card gets
// `break-inside-avoid` so a browser never slices one across two columns.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  KeyRound,
  ArrowUpRight,
  RefreshCw,
  Clock,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { api } from "@/lib/api";
import type {
  ProviderUsageReport,
  ProviderKeyUsage,
  ProviderKeyUsageWindow,
  UsageUnit,
} from "@/lib/types";
import { PageHeader, EmptyState } from "@/components/shared";
import { ProviderIcon } from "@/components/model-icon";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, fmtNum, fmtTokens } from "@/lib/utils";

const KEYS_PER_PAGE = 3;

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
        <UsageSkeleton />
      ) : reports.length === 0 ? (
        <EmptyState msg="No providers yet. Add one to see its key usage." />
      ) : (
        <div className="columns-1 gap-4 sm:columns-2 xl:columns-3">
          {reports.map((r) => (
            <div key={r.providerId} className="mb-4 break-inside-avoid">
              <ProviderUsageCard report={r} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function UsageSkeleton() {
  return (
    <div className="columns-1 gap-4 sm:columns-2 xl:columns-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="mb-4 break-inside-avoid">
          <Card className="gap-4">
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
        </div>
      ))}
    </div>
  );
}

// Fake per-page "poll" delay — long enough to read as a deliberate fetch,
// short enough not to feel sluggish for data that's actually already local.
const PAGE_TRANSITION_MS = 350;

function ProviderUsageCard({ report }: { report: ProviderUsageReport }) {
  const pageCount = Math.max(1, Math.ceil(report.keys.length / KEYS_PER_PAGE));
  const [page, setPage] = useState(0);
  const [pending, setPending] = useState<number | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  // A refresh can change key counts (a provider gains/loses keys); keep the
  // page in bounds instead of stranding the view on a now-empty page.
  useEffect(() => {
    setPage((p) => Math.min(p, pageCount - 1));
  }, [pageCount]);

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  const goToPage = (next: number) => {
    const clamped = Math.max(0, Math.min(pageCount - 1, next));
    if (clamped === page || pending !== null) return;
    setPending(clamped);
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setPage(clamped);
      setPending(null);
    }, PAGE_TRANSITION_MS);
  };

  const shownPage = pending ?? page;

  return (
    <Card className="gap-4">
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
        <KeyPager keys={report.keys} page={page} pendingPage={pending} />
      )}

      {pageCount > 1 && (
        <div className="flex items-center justify-between border-t border-border/60 pt-3">
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={pending !== null || shownPage === 0}
            onClick={() => goToPage(shownPage - 1)}
            aria-label="Previous keys"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="text-[0.65rem] tabular-nums text-muted-foreground">
            Page {shownPage + 1} of {pageCount}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={pending !== null || shownPage === pageCount - 1}
            onClick={() => goToPage(shownPage + 1)}
            aria-label="Next keys"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </Card>
  );
}

// Renders every page's key set stacked in the same grid cell (row 1 / col 1),
// with only the active page visible. Every page therefore contributes to the
// container's natural height, so the tallest page (not just the current one)
// sets the card's height — paging never resizes the card, which would
// otherwise reflow neighboring masonry columns on every click.
//
// While `loading`, a skeleton is layered into the same cell on top of the
// (now-hidden) real pages — the real pages stay mounted so the container's
// height doesn't collapse, but only the skeleton is visible. This makes each
// page change read as its own small "poll" for that card instead of an
// instant, jarring content swap — without a real per-page fetch to await.
function KeyPager({
  keys,
  page,
  pendingPage,
}: {
  keys: ProviderKeyUsage[];
  page: number;
  pendingPage: number | null;
}) {
  const pages: ProviderKeyUsage[][] = [];
  for (let i = 0; i < keys.length; i += KEYS_PER_PAGE) {
    pages.push(keys.slice(i, i + KEYS_PER_PAGE));
  }
  const loading = pendingPage !== null;
  const skeletonCount =
    pendingPage !== null ? (pages[pendingPage]?.length ?? KEYS_PER_PAGE) : 0;
  return (
    <div className="grid">
      {pages.map((pageKeys, i) => (
        <div
          key={i}
          className={cn(
            "col-start-1 row-start-1 space-y-3",
            i === page && !loading
              ? "visible"
              : "invisible pointer-events-none select-none",
          )}
          aria-hidden={i === page && !loading ? undefined : true}
        >
          {pageKeys.map((k, j) => (
            <KeyUsageBlock key={j} usage={k} />
          ))}
        </div>
      ))}
      {loading && (
        <div className="col-start-1 row-start-1 space-y-3" aria-hidden>
          {Array.from({ length: skeletonCount }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      )}
    </div>
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
