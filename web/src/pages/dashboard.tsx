import { Link } from "react-router-dom";
import type { OverviewResponse } from "@/lib/types";
import { useWsSubscription } from "@/hooks/use-ws";
import { fmtNum, fmtUsd } from "@/lib/utils";
import {
  PageHeader,
  Stat,
  StatGridSkeleton,
  TableSkeleton,
  EmptyState,
  TokenChart,
} from "@/components/shared";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ModelIcon, ProviderIcon, useModelTypes } from "@/components/model-icon";

export default function Dashboard() {
  const { data } = useWsSubscription<OverviewResponse>("overview");
  const modelTypes = useModelTypes();
  if (!data)
    return (
      <div>
        <PageHeader
          title="Overview"
          desc="Live gateway telemetry — real-time via WebSocket"
        />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatGridSkeleton count={4} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatGridSkeleton count={4} />
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <Card className="min-w-0 lg:col-span-2">
            <CardHeader>
              <Skeleton className="h-4 w-48" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-40 w-full" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <Skeleton className="h-4 w-32" />
            </CardHeader>
            <CardContent className="p-0">
              <TableSkeleton
                rows={5}
                cols={4}
                widths={["70%", "40%", "40%", "30%"]}
              />
            </CardContent>
          </Card>
        </div>
        <Card className="mt-3">
          <CardHeader>
            <Skeleton className="h-4 w-36" />
          </CardHeader>
          <CardContent className="p-0">
            <TableSkeleton
              rows={5}
              cols={4}
              widths={["60%", "40%", "40%", "30%"]}
            />
          </CardContent>
        </Card>
      </div>
    );

  const s = data.stats;
  const hourly = data.hourlyUsage ?? [];

  return (
    <div>
      <PageHeader
        title="Overview"
        desc="Live gateway telemetry — real-time via WebSocket"
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <Stat label="Requests today" value={fmtNum(s.requestsToday)} accent />
        <Stat
          label="Tokens today"
          value={fmtNum(s.tokensToday)}
          hint="input + output"
        />
        <Stat
          label="Error rate"
          value={`${s.errorRateToday.toFixed(1)}%`}
          hint={
            s.throttledToday > 0
              ? `${fmtNum(s.requestsErrorToday)} failed · ${fmtNum(s.throttledToday)} throttled`
              : `${fmtNum(s.requestsErrorToday)} failed`
          }
          accent={s.errorRateToday > 5}
        />
        <Stat
          label="P95 latency"
          value={
            s.p95LatencyMs != null
              ? `${(s.p95LatencyMs / 1000).toFixed(2)}s`
              : "—"
          }
        />
        <Stat
          label="Cost today (est.)"
          value={fmtUsd(s.costUsdToday)}
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <Stat label="Providers" value={fmtNum(data.providers)} />
        <Stat label="Models" value={fmtNum(data.models)} />
        <Stat label="Active keys" value={fmtNum(data.keys)} />
        <Stat
          label="HTTP 5xx today"
          value={fmtNum(s.statusBands.serverError)}
        />
        <Stat
          label="Throttled today"
          value={fmtNum(s.throttledToday)}
          hint="rate-limited (transient)"
          accent={s.throttledToday > 0}
        />
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-5">
        {/* Token usage by hour — real-time (last 24h) */}
        <Card className="min-w-0 lg:col-span-3">
          <CardHeader>
            <CardTitle>Token Usage — Last 24 Hours</CardTitle>
            <CardAction>
              <Badge variant="secondary">{fmtNum(s.tokensToday)} today</Badge>
            </CardAction>
          </CardHeader>
          <CardContent>
            {hourly.every((h) => h.tokens === 0) ? (
              <EmptyState msg="No usage in the last 24 hours" />
            ) : (
              <TokenChart
                data={hourly.map((h) => ({
                  label: fmtHourLabel(h.hour),
                  tokens: h.tokens,
                }))}
              />
            )}
          </CardContent>
        </Card>

        {/* Top models */}
        <Card className="min-w-0 lg:col-span-2">
          <CardHeader>
            <CardTitle>Top Models Today</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {s.byModel.length === 0 ? (
              <EmptyState msg="No requests today" />
            ) : (
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[40%]">Model</TableHead>
                    <TableHead className="w-20 text-right">Requests</TableHead>
                    <TableHead className="w-24 text-right">Tokens</TableHead>
                    <TableHead className="w-20 text-right">Cached</TableHead>
                    <TableHead className="w-24 text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {s.byModel.map((m) => (
                    <TableRow key={m.model}>
                      <TableCell className="min-w-0 font-mono text-primary">
                        <span className="flex min-w-0 items-center gap-2">
                          <ModelIcon
                            alias={m.model}
                            type={modelTypes[m.model]}
                          />
                          <span className="truncate">{m.model}</span>
                        </span>
                      </TableCell>
                      <TableCell className="w-20 text-right tabular-nums whitespace-nowrap">
                        {fmtNum(m.requests)}
                      </TableCell>
                      <TableCell className="w-24 text-right tabular-nums whitespace-nowrap">
                        {fmtNum(m.tokens)}
                      </TableCell>
                      <TableCell className="w-20 text-right tabular-nums text-muted-foreground whitespace-nowrap">
                        {m.cached > 0 ? fmtNum(m.cached) : "—"}
                      </TableCell>
                      <TableCell className="w-24 text-right tabular-nums text-muted-foreground whitespace-nowrap">
                        {m.costUsd > 0 ? fmtUsd(m.costUsd) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-3 min-w-0">
        <CardHeader>
          <CardTitle>Provider Load Today</CardTitle>
          <Link
            to="/logs"
            className="text-xs font-medium text-muted-foreground transition-colors hover:text-primary cursor-pointer"
          >
            view logs →
          </Link>
        </CardHeader>
        <CardContent className="p-0">
          {s.byProvider.length === 0 ? (
            <EmptyState msg="No upstream activity today" />
          ) : (
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[40%]">Provider</TableHead>
                  <TableHead className="w-[13%] text-right">Requests</TableHead>
                  <TableHead className="w-[13%] text-right">Tokens</TableHead>
                  <TableHead className="w-[17%] text-right">Cost</TableHead>
                  <TableHead className="w-[17%] text-right">Share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.byProvider.map((p) => {
                  const total = s.byProvider.reduce(
                    (a, x) => a + x.requests,
                    0,
                  );
                  return (
                    <TableRow key={p.providerId}>
                      <TableCell
                        className="min-w-0"
                        title={p.provider}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <ProviderIcon
                            brand={p.catalogId}
                            name={p.provider}
                            className="size-3.5"
                          />
                          <span className="truncate">{p.provider}</span>
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtNum(p.requests)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtNum(p.tokens)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {p.costUsd > 0 ? fmtUsd(p.costUsd) : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {total
                          ? `${((p.requests / total) * 100).toFixed(0)}%`
                          : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// "YYYY-MM-DDTHH" (UTC) -> local "HH:00" for axis/tooltip labels.
function fmtHourLabel(hour: string | undefined): string {
  if (!hour) return "";
  const d = new Date(`${hour}:00:00Z`);
  if (Number.isNaN(d.getTime())) return hour;
  return `${String(d.getHours()).padStart(2, "0")}:00`;
}
