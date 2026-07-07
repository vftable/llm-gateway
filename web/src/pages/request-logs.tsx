import { memo, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { RequestLog } from "@/lib/types";
import {
  PageHeader,
  Spinner,
  EmptyState,
  Pagination,
} from "@/components/shared";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { fmtTime, fmtNum } from "@/lib/utils";
import { ModelIcon, useModelTypes } from "@/components/model-icon";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;

export default function RequestLogs() {
  const [items, setItems] = useState<RequestLog[] | null>(null);
  const [model, setModel] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [page, setPage] = useState(0);
  const modelTypes = useModelTypes();

  // reset to the first page whenever filters change
  useEffect(() => {
    setPage(0);
  }, [model, errorsOnly]);

  useEffect(() => {
    const load = () =>
      api
        .requestLogs({
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
          model: model || undefined,
          error: errorsOnly ? "1" : undefined,
        })
        .then(setItems)
        .catch(() => {});
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [model, errorsOnly, page]);

  return (
    <div>
      <PageHeader
        title="Request Logs"
        desc="Per-request activity — auto-refreshes every 10 seconds"
        actions={
          <div className="flex items-center gap-3">
            <Input
              placeholder="filter by model…"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-48"
            />
            <label className="flex items-center gap-2">
              <Switch checked={errorsOnly} onCheckedChange={setErrorsOnly} />
              <span className="text-xs font-medium text-muted-foreground normal-case">
                errors only
              </span>
            </label>
          </div>
        }
      />

      <Card>
        <CardContent className="p-0">
          {!items ? (
            <Spinner />
          ) : items.length === 0 && page === 0 ? (
            <EmptyState msg="No matching requests" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                  <TableHead className="text-right">Tok In/Out</TableHead>
                  <TableHead className="text-right">Latency</TableHead>
                  <TableHead>Note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((l) => (
                  <LogRow
                    key={l.id}
                    log={l}
                    type={l.model ? modelTypes[l.model] : undefined}
                  />
                ))}
              </TableBody>
            </Table>
          )}
          {items && (
            <Pagination
              page={page}
              hasNext={items.length === PAGE_SIZE}
              onChange={setPage}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const LogRow = memo(function LogRow({
  log: l,
  type,
}: {
  log: RequestLog;
  type: string | undefined;
}) {
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {fmtTime(l.ts)}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {l.apiKeyName ? (
          l.apiKeyName
        ) : l.keyPrefix ? (
          <span className="font-mono text-primary">{l.keyPrefix}</span>
        ) : (
          "anon"
        )}
      </TableCell>
      <TableCell>
        {l.client ? (
          <Badge variant="secondary">{l.client}</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="font-mono text-primary">
        {l.model ? (
          <span className="flex items-center gap-2">
            <ModelIcon alias={l.model} type={type} />
            {l.model}
          </span>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {l.providerName ?? l.providerId ?? "—"}
        {l.upstreamModel ? (
          <span className="block text-[0.6rem] text-muted-foreground/70">
            {l.upstreamModel}
          </span>
        ) : null}
      </TableCell>
      <TableCell className="text-right">
        <StatusBadge status={l.status} />
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {l.inputTokens != null || l.outputTokens != null
          ? `${fmtNum(l.inputTokens)}/${fmtNum(l.outputTokens)}`
          : "—"}
        {l.stream && (
          <span className="ml-1 text-[0.6rem] text-primary">stream</span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {fmtLatency(l.latencyMs)}
      </TableCell>
      <TableCell className="max-w-[20rem] truncate text-amber-500 dark:text-amber-400">
        {l.error ?? ""}
      </TableCell>
    </TableRow>
  );
});

function fmtLatency(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function StatusBadge({ status }: { status: number | null }) {
  if (status == null)
    return (
      <Badge variant="secondary" className={cn("tabular-nums")}>
        —
      </Badge>
    );
  const variant =
    status >= 500
      ? "destructive"
      : status >= 400
        ? "warning"
        : status >= 200
          ? "success"
          : "secondary";
  return (
    <Badge variant={variant} className="tabular-nums">
      {status}
    </Badge>
  );
}
