import { Fragment, memo, useState } from "react";
import { ChevronDown, ChevronRight, Pencil, Check, X } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useWsSubscription } from "@/hooks/use-ws";
import type {
  FullBreakdownRow,
  ModelResolutionRow,
  UsageBreakdownRow,
  UsageResponse,
} from "@/lib/types";
import {
  PageHeader,
  TableSkeleton,
  StatGridSkeleton,
  EmptyState,
  Stat,
  Field,
  Pagination,
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmtNum, fmtUsd } from "@/lib/utils";
import { ModelIcon, ProviderIcon, useModelTypes } from "@/components/model-icon";

const BREAKDOWN_PAGE_SIZE = 15;
const KEYS_PAGE_SIZE = 10;

export default function Usage() {
  const { data } = useWsSubscription<UsageResponse>("usage");
  const { data: breakdownData } = useWsSubscription<{
    rows: FullBreakdownRow[];
  }>("usage:breakdown");
  const rows = breakdownData?.rows ?? [];
  const [breakdownPage, setBreakdownPage] = useState(0);
  const [keysPage, setKeysPage] = useState(0);
  const [modelQuery, setModelQuery] = useState("");
  const [resolution, setResolution] = useState<ModelResolutionRow[] | null>(
    null,
  );
  const modelTypes = useModelTypes();

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

  if (!data)
    return (
      <div>
        <PageHeader
          title="Usage"
          desc="Per-key token consumption, quotas and provider resolution — resets at UTC midnight"
        />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatGridSkeleton count={4} />
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <Card className="min-w-0 self-start lg:col-span-1">
            <CardHeader>
              <Skeleton className="h-4 w-32" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-40 w-full" />
            </CardContent>
          </Card>
          <Card className="min-w-0 lg:col-span-2">
            <CardHeader>
              <Skeleton className="h-4 w-48" />
            </CardHeader>
            <CardContent className="p-0">
              <TableSkeleton
                rows={6}
                cols={6}
                widths={["10%", "50%", "40%", "60%", "30%", "30%"]}
              />
            </CardContent>
          </Card>
        </div>
        <Card className="mt-3 min-w-0">
          <CardHeader>
            <Skeleton className="h-4 w-56" />
          </CardHeader>
          <CardContent className="p-0">
            <TableSkeleton
              rows={6}
              cols={7}
              widths={["50%", "40%", "60%", "60%", "30%", "30%", "30%"]}
            />
          </CardContent>
        </Card>
      </div>
    );

  const sorted = [...data.today.keys].sort((a, b) => b.used - a.used);
  const keysPageCount = Math.max(1, Math.ceil(sorted.length / KEYS_PAGE_SIZE));
  // Clamp so a shrinking key list (or the 20s refresh) can't strand us past
  // the last page.
  const keysPageClamped = Math.min(keysPage, keysPageCount - 1);
  const visibleKeys = sorted.slice(
    keysPageClamped * KEYS_PAGE_SIZE,
    (keysPageClamped + 1) * KEYS_PAGE_SIZE,
  );
  const totalBreakdownTokens = rows.reduce((a, r) => a + r.tokens, 0);
  const totalBreakdownCost = rows.reduce((a, r) => a + r.costUsd, 0);
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
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <Stat label="Tokens today" value={fmtNum(data.today.total)} accent />
        <Stat label="Tracked keys" value={fmtNum(data.today.keys.length)} />
        <Stat
          label="Keys over quota"
          value={fmtNum(
            data.today.keys.filter((k) => k.limit && k.used >= k.limit).length,
          )}
        />
        <Stat label="Resolved requests" value={fmtNum(rows.length)} />
        <Stat
          label="Cost today (est.)"
          value={fmtUsd(totalBreakdownCost)}
        />
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
        {/* self-start keeps the chart at its natural height instead of being
            stretched to match the (taller, expandable) keys card in the same
            grid row — which otherwise inflated the chart and never shrank back. */}
        <Card className="min-w-0 self-start lg:col-span-1">
          <CardHeader>
            <CardTitle>14-Day History</CardTitle>
            <CardAction>
              <Badge variant="secondary">
                {fmtNum(data.today.total)} today
              </Badge>
            </CardAction>
          </CardHeader>
          <CardContent>
            <TokenChart
              data={data.history.map((h) => ({
                label: h.day.slice(5),
                tokens: h.tokens,
              }))}
            />
          </CardContent>
        </Card>

        {/* Per-key usage with inline quota editing + drill-down breakdown */}
        <Card className="min-w-0 lg:col-span-2">
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
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead className="w-48">Key</TableHead>
                    <TableHead className="w-32">Owner</TableHead>
                    <TableHead className="w-44">Quota / Day</TableHead>
                    <TableHead className="w-24 text-right">Used</TableHead>
                    <TableHead className="w-28 text-right">Remaining</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleKeys.map((k) => (
                    <KeyUsageRow
                      key={k.apiKeyId}
                      row={k}
                      onChanged={() => {}}
                    />
                  ))}
                </TableBody>
              </Table>
            )}
            {sorted.length > 0 && (
              <Pagination
                page={keysPageClamped}
                pageCount={keysPageCount}
                onChange={setKeysPage}
              />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Per-(key, model, provider) breakdown — "what did each request resolve to" */}
      <Card className="mt-3 min-w-0">
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
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((r, i) => (
                  <TableRow key={breakdownPage * BREAKDOWN_PAGE_SIZE + i}>
                    <TableCell className="font-mono text-primary">
                      {r.keyPrefix}
                    </TableCell>
                    <TableCell className="max-w-[10rem] truncate text-muted-foreground">
                      {r.userName ?? "—"}
                    </TableCell>
                    <TableCell className="max-w-[14rem] font-mono">
                      <span className="flex min-w-0 items-center gap-2">
                        <ModelIcon alias={r.model} type={modelTypes[r.model]} />
                        <span className="truncate">{r.model}</span>
                      </span>
                    </TableCell>
                    <TableCell>
                      {r.providerName ? (
                        <Badge variant="default" className="max-w-[8rem] truncate">
                          {r.providerName}
                        </Badge>
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
                      {r.costUsd > 0 ? fmtUsd(r.costUsd) : "—"}
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
      <Card className="mt-3 min-w-0">
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
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[40%]">Provider Resolved</TableHead>
                      <TableHead className="w-24 text-right">Requests</TableHead>
                      <TableHead className="w-24 text-right">Tokens</TableHead>
                      <TableHead className="w-24 text-right">Cost</TableHead>
                      <TableHead className="w-20 text-right">Share</TableHead>
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
                          <TableCell
                            className="min-w-0"
                            title={r.providerName ?? r.providerId ?? "(unknown)"}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <ProviderIcon
                                brand={r.providerId?.replace(/-[0-9a-f]{8}$/, "")}
                                name={r.providerName ?? r.providerId ?? undefined}
                                className="size-3.5"
                              />
                              <span className="truncate">
                                {r.providerName ?? r.providerId ?? "(unknown)"}
                              </span>
                            </span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtNum(r.requests)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtNum(r.tokens)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {r.costUsd > 0 ? fmtUsd(r.costUsd) : "—"}
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
          <div className="truncate font-mono text-primary">{k.keyPrefix}</div>
          <div className="truncate text-[0.65rem] text-muted-foreground">
            {k.keyName ?? "—"}
          </div>
        </TableCell>
        <TableCell className="truncate text-muted-foreground">
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
                size="icon-sm"
                onClick={saveQuota}
                disabled={saving}
                title="Save"
              >
                <Check className="h-3.5 w-3.5 text-primary" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
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
                              ? "h-full rounded-full bg-warning"
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
              <Button
                variant="ghost"
                size="icon-xs"
                title="Edit quota"
                onClick={() => setEditing(true)}
                className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/quota:opacity-100"
              >
                <Pencil className="h-3 w-3" />
              </Button>
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
              <TableSkeleton
                rows={3}
                cols={5}
                widths={["70%", "40%", "30%", "30%", "20%"]}
              />
            ) : detail.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">
                No requests from this key today.
              </p>
            ) : (
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-12">Model</TableHead>
                    <TableHead className="w-44">Provider</TableHead>
                    <TableHead className="w-24 text-right">Requests</TableHead>
                    <TableHead className="w-28 text-right">Tokens</TableHead>
                    <TableHead className="w-20 text-right">Cost</TableHead>
                    <TableHead className="w-20 text-right pr-4">
                      Share
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.map((d, i) => {
                    const total = detail.reduce((a, x) => a + x.tokens, 0);
                    return (
                      <TableRow key={i}>
                        <TableCell className="max-w-[16rem] pl-12 font-mono">
                          <span className="flex min-w-0 items-center gap-2">
                            <ModelIcon
                              alias={d.model}
                              type={modelTypes[d.model]}
                            />
                            <span className="truncate">{d.model}</span>
                          </span>
                        </TableCell>
                        <TableCell className="max-w-[12rem]">
                          {d.providerName ? (
                            <Badge variant="secondary" className="truncate">
                              {d.providerName}
                            </Badge>
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
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {d.costUsd > 0 ? fmtUsd(d.costUsd) : "—"}
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
