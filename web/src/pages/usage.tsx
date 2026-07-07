import { Fragment, memo, useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Pencil, Check, X } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type {
  FullBreakdownRow,
  ModelResolutionRow,
  UsageBreakdownRow,
  UsageResponse,
} from "@/lib/types";
import {
  PageHeader,
  Spinner,
  EmptyState,
  Stat,
  Field,
  Pagination,
} from "@/components/shared";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmtNum } from "@/lib/utils";
import { ModelIcon, useModelTypes } from "@/components/model-icon";

const BREAKDOWN_PAGE_SIZE = 15;

export default function Usage() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [rows, setRows] = useState<FullBreakdownRow[]>([]);
  const [breakdownPage, setBreakdownPage] = useState(0);
  const [modelQuery, setModelQuery] = useState("");
  const [resolution, setResolution] = useState<ModelResolutionRow[] | null>(
    null,
  );
  const modelTypes = useModelTypes();

  const loadAll = useCallback(() => {
    api
      .usage()
      .then(setData)
      .catch(() => {});
    api
      .usageBreakdown()
      .then((r) => setRows(r.rows))
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadAll();
    const t = setInterval(loadAll, 20000);
    return () => clearInterval(t);
  }, [loadAll]);

  // "If a user uses model X, what provider did it resolve to?" lookup.
  const resolve = (m: string) => {
    if (!m.trim()) {
      setResolution(null);
      return;
    }
    api
      .usageForModel(m.trim())
      .then((r) => setResolution(r.rows))
      .catch(() => setResolution([]));
  };

  if (!data) return <Spinner label="Loading usage…" />;

  const maxHist = Math.max(1, ...data.history.map((h) => h.tokens));
  const sorted = [...data.today.keys].sort((a, b) => b.used - a.used);
  const totalBreakdownTokens = rows.reduce((a, r) => a + r.tokens, 0);
  const breakdownPageCount = Math.max(
    1,
    Math.ceil(rows.length / BREAKDOWN_PAGE_SIZE),
  );
  const visibleRows = rows.slice(
    breakdownPage * BREAKDOWN_PAGE_SIZE,
    (breakdownPage + 1) * BREAKDOWN_PAGE_SIZE,
  );

  return (
    <div>
      <PageHeader
        title="Usage"
        desc="Per-key token consumption, quotas and provider resolution — resets at UTC midnight"
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Tokens today" value={fmtNum(data.today.total)} accent />
        <Stat label="Tracked keys" value={fmtNum(data.today.keys.length)} />
        <Stat
          label="Keys over quota"
          value={fmtNum(
            data.today.keys.filter((k) => k.limit && k.used >= k.limit).length,
          )}
        />
        <Stat label="Resolved requests" value={fmtNum(rows.length)} />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>14-Day History</CardTitle>
            <CardAction>
              <Badge variant="secondary">{fmtNum(data.today.total)} today</Badge>
            </CardAction>
          </CardHeader>
          <CardContent>
            <div className="flex h-40 items-end gap-1">
              {data.history.map((h, i) => {
                // Final bucket is today (still accumulating) — solid violet.
                const isToday = i === data.history.length - 1;
                return (
                  <div
                    key={h.day}
                    className="group relative flex-1"
                    title={`${h.day}: ${fmtNum(h.tokens)}${isToday ? " · so far today" : ""}`}
                  >
                    <div
                      className={
                        isToday
                          ? "w-full rounded-t-sm bg-violet-500 transition-colors group-hover:bg-violet-400"
                          : "w-full rounded-t-sm bg-violet-500/30 transition-colors group-hover:bg-violet-500/60"
                      }
                      style={{
                        height: `${(h.tokens / maxHist) * 100}%`,
                        minHeight: h.tokens > 0 ? "2px" : "0",
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Per-key usage with inline quota editing + drill-down breakdown */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Keys Today · Usage & Limits</CardTitle>
            <CardAction>
              <Badge variant="secondary">{sorted.length}</Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="p-0">
            {sorted.length === 0 ? (
              <EmptyState msg="No keys yet — create one on the API Keys page" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Key</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead className="w-44">Quota / Day</TableHead>
                    <TableHead className="text-right">Used</TableHead>
                    <TableHead className="text-right">Remaining</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((k) => (
                    <KeyUsageRow key={k.apiKeyId} row={k} onChanged={loadAll} />
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Per-(key, model, provider) breakdown — "what did each request resolve to" */}
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Resolution by Key, Model & Provider</CardTitle>
          <CardAction>
            <Badge variant="default">
              {fmtNum(totalBreakdownTokens)} tokens
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <EmptyState msg="No resolved requests yet — send a request through the gateway" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Model Requested</TableHead>
                  <TableHead>Resolved Provider</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((r, i) => (
                  <TableRow key={breakdownPage * BREAKDOWN_PAGE_SIZE + i}>
                    <TableCell className="font-mono text-primary">
                      {r.keyPrefix}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.userName ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono">
                      <span className="flex items-center gap-2">
                        <ModelIcon alias={r.model} type={modelTypes[r.model]} />
                        {r.model}
                      </span>
                    </TableCell>
                    <TableCell>
                      {r.providerName ? (
                        <Badge variant="default">{r.providerName}</Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmtNum(r.requests)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmtNum(r.tokens)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {totalBreakdownTokens
                        ? `${((r.tokens / totalBreakdownTokens) * 100).toFixed(0)}%`
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {rows.length > 0 && (
            <Pagination
              page={breakdownPage}
              pageCount={breakdownPageCount}
              onChange={setBreakdownPage}
            />
          )}
        </CardContent>
      </Card>

      {/* Model resolution lookup — "gpt-5.5 resolved to which provider + tokens" */}
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Model Resolver</CardTitle>
        </CardHeader>
        <CardContent>
          <Field label="Enter a model alias (e.g. gpt-5.5) to see which providers it resolved to today">
            <div className="flex gap-2">
              <Input
                value={modelQuery}
                onChange={(e) => setModelQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && resolve(modelQuery)}
                placeholder="gpt-5.5"
                className="max-w-xs"
              />
            </div>
          </Field>
          {resolution && (
            <div className="mt-3">
              {resolution.length === 0 ? (
                <EmptyState
                  msg={`No requests for '${modelQuery}' resolved today`}
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Provider Resolved</TableHead>
                      <TableHead className="text-right">Requests</TableHead>
                      <TableHead className="text-right">Tokens</TableHead>
                      <TableHead className="text-right">Share</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {resolution.map((r, i) => {
                      const total = resolution.reduce(
                        (a, x) => a + x.tokens,
                        0,
                      );
                      return (
                        <TableRow key={i}>
                          <TableCell>
                            <Badge variant="default">
                              {r.providerName ?? r.providerId ?? "(unknown)"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtNum(r.requests)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtNum(r.tokens)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {total
                              ? `${((r.tokens / total) * 100).toFixed(0)}%`
                              : "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// One key row: quota progress bar, inline quota editing, and an expandable
// per-model/provider breakdown for the day.
const KeyUsageRow = memo(function KeyUsageRow({
  row: k,
  onChanged,
}: {
  row: UsageResponse["today"]["keys"][number];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<UsageBreakdownRow[] | null>(null);
  const modelTypes = useModelTypes();
  const [editing, setEditing] = useState(false);
  const [quota, setQuota] = useState(k.limit?.toString() ?? "");
  const [saving, setSaving] = useState(false);

  const pct =
    k.limit && k.limit > 0 ? Math.min(100, (k.used / k.limit) * 100) : 0;
  const over = k.limit ? k.used >= k.limit : false;
  const warn = !over && k.limit ? k.used >= k.limit * 0.8 : false;

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    if (next && detail === null) {
      api
        .usageForKey(k.apiKeyId)
        .then((r) => setDetail(r.rows))
        .catch(() => setDetail([]));
    }
  };

  const saveQuota = async () => {
    setSaving(true);
    try {
      await api.updateApiKey(k.apiKeyId, {
        tokensPerDay: quota.trim() ? Number(quota) : null,
      });
      toast.success(
        quota.trim()
          ? `Quota set to ${fmtNum(Number(quota))} tokens/day`
          : "Quota removed (unlimited)",
      );
      setEditing(false);
      onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Fragment>
      <TableRow className="cursor-pointer" onClick={toggleOpen}>
        <TableCell className="text-muted-foreground">
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </TableCell>
        <TableCell>
          <div className="font-mono text-primary">{k.keyPrefix}</div>
          <div className="text-[0.65rem] text-muted-foreground">
            {k.keyName ?? "—"}
          </div>
        </TableCell>
        <TableCell className="text-muted-foreground">
          {k.userName ?? "—"}
        </TableCell>
        <TableCell onClick={(e) => e.stopPropagation()}>
          {editing ? (
            <div className="flex items-center gap-1">
              <Input
                type="number"
                value={quota}
                onChange={(e) => setQuota(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveQuota()}
                placeholder="unlimited"
                className="h-7 w-28 text-xs"
                autoFocus
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={saveQuota}
                disabled={saving}
                title="Save"
              >
                <Check className="h-3.5 w-3.5 text-primary" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  setEditing(false);
                  setQuota(k.limit?.toString() ?? "");
                }}
                title="Cancel"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <div className="group/quota flex items-center gap-2">
              <div className="min-w-0 flex-1">
                {k.limit ? (
                  <div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={
                          over
                            ? "h-full rounded-full bg-destructive"
                            : warn
                              ? "h-full rounded-full bg-amber-500"
                              : "h-full rounded-full bg-primary"
                        }
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="mt-0.5 text-[0.6rem] text-muted-foreground">
                      {pct.toFixed(0)}% of {fmtNum(k.limit)}
                    </div>
                  </div>
                ) : (
                  <span className="text-muted-foreground">∞ unlimited</span>
                )}
              </div>
              <button
                type="button"
                title="Edit quota"
                onClick={() => setEditing(true)}
                className="cursor-pointer text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/quota:opacity-100"
              >
                <Pencil className="h-3 w-3" />
              </button>
            </div>
          )}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {fmtNum(k.used)}
        </TableCell>
        <TableCell className="text-right tabular-nums text-muted-foreground">
          {k.limit ? (
            over ? (
              <Badge variant="destructive">exhausted</Badge>
            ) : (
              fmtNum(k.limit - k.used)
            )
          ) : (
            "∞"
          )}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={6} className="bg-muted/30 p-0">
            {detail === null ? (
              <div className="p-3">
                <Spinner />
              </div>
            ) : detail.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">
                No requests from this key today.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-12">Model</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Tokens</TableHead>
                    <TableHead className="text-right pr-4">Share</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.map((d, i) => {
                    const total = detail.reduce((a, x) => a + x.tokens, 0);
                    return (
                      <TableRow key={i}>
                        <TableCell className="pl-12 font-mono">
                          <span className="flex items-center gap-2">
                            <ModelIcon
                              alias={d.model}
                              type={modelTypes[d.model]}
                            />
                            {d.model}
                          </span>
                        </TableCell>
                        <TableCell>
                          {d.providerName ? (
                            <Badge variant="secondary">{d.providerName}</Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {fmtNum(d.requests)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {fmtNum(d.tokens)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground pr-4">
                          {total
                            ? `${((d.tokens / total) * 100).toFixed(0)}%`
                            : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
});
