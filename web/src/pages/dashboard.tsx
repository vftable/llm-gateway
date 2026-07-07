import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import type { OverviewResponse } from "@/lib/types";
import { fmtNum } from "@/lib/utils";
import { PageHeader, Stat, Spinner, EmptyState } from "@/components/shared";
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

export default function Dashboard() {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .overview()
      .then(setData)
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  if (error) return <EmptyState msg={`error: ${error}`} />;
  if (!data) return <Spinner label="Fetching telemetry…" />;

  const s = data.stats;
  const maxTokens = Math.max(1, ...data.usageHistory.map((h) => h.tokens));

  return (
    <div>
      <PageHeader
        title="Overview"
        desc="Live gateway telemetry — auto-refreshes every 15 seconds"
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Requests today" value={fmtNum(s.requestsToday)} accent />
        <Stat
          label="Tokens today"
          value={fmtNum(s.tokensToday)}
          hint="input + output"
        />
        <Stat
          label="Error rate"
          value={`${s.errorRateToday.toFixed(1)}%`}
          hint={`${fmtNum(s.requestsErrorToday)} failed`}
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
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Providers" value={fmtNum(data.providers)} />
        <Stat label="Models" value={fmtNum(data.models)} />
        <Stat label="Active keys" value={fmtNum(data.keys)} />
        <Stat
          label="HTTP 5xx today"
          value={fmtNum(s.statusBands.serverError)}
        />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Usage over time */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Token Usage — Last 14 Days</CardTitle>
            <CardAction>
              <Badge variant="secondary">{fmtNum(s.tokensToday)} today</Badge>
            </CardAction>
          </CardHeader>
          <CardContent>
            {data.usageHistory.length === 0 ? (
              <EmptyState msg="No usage recorded yet" />
            ) : (
              <div className="flex h-40 items-end gap-1">
                {data.usageHistory.map((h, i) => {
                  // The final bucket is today (still accumulating) — render it
                  // solid so "usage so far today" reads at a glance.
                  const isToday = i === data.usageHistory.length - 1;
                  return (
                    <div
                      key={h.day}
                      className="group relative flex-1"
                      title={`${h.day}: ${fmtNum(h.tokens)} tokens${isToday ? " · so far today" : ""}`}
                    >
                      <div
                        className={
                          isToday
                            ? "w-full rounded-t-sm bg-violet-500 transition-colors group-hover:bg-violet-400"
                            : "w-full rounded-t-sm bg-violet-500/30 transition-colors group-hover:bg-violet-500/60"
                        }
                        style={{
                          height: `${(h.tokens / maxTokens) * 100}%`,
                          minHeight: h.tokens > 0 ? "2px" : "0",
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-2 flex justify-between text-xs font-medium text-muted-foreground">
              <span>{data.usageHistory[0]?.day.slice(5) ?? ""}</span>
              <span>
                {data.usageHistory[data.usageHistory.length - 1]?.day.slice(
                  5,
                ) ?? ""}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Top models */}
        <Card>
          <CardHeader>
            <CardTitle>Top Models Today</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {s.byModel.length === 0 ? (
              <EmptyState msg="No requests today" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Tokens</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {s.byModel.map((m) => (
                    <TableRow key={m.model}>
                      <TableCell className="font-mono text-primary">
                        {m.model}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtNum(m.requests)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtNum(m.tokens)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Share</TableHead>
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
                      <TableCell>{p.provider}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtNum(p.requests)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtNum(p.tokens)}
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
