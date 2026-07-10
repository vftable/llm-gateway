// Overview tab: summary rows, a connectivity test button, and recent failed
// requests routed through this provider.

import { useCallback, useEffect, useState } from "react";
import { FlaskConical, Loader2, ChevronRight, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type {
  Provider,
  ProviderTestResult,
  RequestLog,
  RequestLogDetail,
} from "@/lib/types";
import { WIRE_KINDS, WIRE_KIND_LABELS } from "@/lib/types";
import { TableSkeleton, FormSection } from "@/components/shared";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  DebugPanel,
  StatusBadge,
  fmtLatency,
} from "@/components/request-log-debug";
import { cn, fmtTime, formatLabel, authSchemeLabel } from "@/lib/utils";

export function OverviewTab({
  provider,
  modelCount,
}: {
  provider: Provider;
  modelCount: number;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const test = async () => {
    setTesting(true);
    try {
      setResult(await api.testProvider(provider.id));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTesting(false);
    }
  };
  const endpointLabels = (
    provider.nativeConversion ? WIRE_KINDS : provider.endpoints
  )
    .map((k) => WIRE_KIND_LABELS[k])
    .join(" · ");
  const rows: Array<[string, React.ReactNode]> = [
    ["Status", provider.enabled ? "Enabled" : "Disabled"],
    [
      "Conversion",
      provider.nativeConversion
        ? "Provider converts — accepts all three endpoints"
        : `Gateway converts${provider.format ? ` (native ${formatLabel(provider.format)})` : ""}`,
    ],
    [
      "Endpoints",
      <span className="block truncate" title={endpointLabels}>
        {endpointLabels || "—"}
      </span>,
    ],
    ["Auth scheme", authSchemeLabel(provider.authScheme)],
    [
      "API keys",
      (provider.disabledApiKeys?.length ?? 0) > 0
        ? `${provider.apiKeys.length} active · ${provider.disabledApiKeys.length} off`
        : `${provider.apiKeys.length}`,
    ],
    ["Imported models", `${provider.importedModelCount ?? 0}`],
    ["Models routed", `${modelCount}`],
    [
      "Retries",
      `${provider.retryAttempts}× / ${Math.round(provider.retryIntervalMs / 1000)}s`,
    ],
    ["Timeout", `${Math.round(provider.requestTimeoutMs / 1000)}s`],
    ["TLS verification", provider.tlsVerify ? "On" : "Off"],
    ["Catalog", provider.catalogId ?? "—"],
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div
            key={k}
            className="flex items-center justify-between gap-3 border-b border-border/60 py-1.5"
          >
            <span className="shrink-0 text-muted-foreground">{k}</span>
            <span
              className="min-w-0 truncate text-right font-medium text-foreground"
              title={typeof v === "string" ? v : undefined}
            >
              {v}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={test} disabled={testing}>
          {testing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FlaskConical className="h-3.5 w-3.5" />
          )}
          Test connection
        </Button>
        {result && (
          <div className="flex animate-in items-center gap-2 fade-in-0 slide-in-from-left-1 duration-200 ease-sidebar">
            <Badge
              variant={result.ok ? "success" : "destructive"}
              // On failure, always show a status code or transport error — never
              // a bare "Failed" with no diagnostic (see key-manager.tsx's
              // per-key Test tooltip, which already gets this right; this
              // mirrors it). `sample` (a snippet of the raw response body, when
              // present) rides in the title for hover detail without cluttering
              // the badge itself.
              title={result.sample}
            >
              {result.ok
                ? `Reachable · ${result.ms}ms`
                : `Failed${result.status ? ` (${result.status})` : ""}${
                    result.error ? ` — ${result.error}` : ""
                  }`}
            </Badge>
            {result.keyMask && (
              <span
                className="font-mono text-xs text-muted-foreground"
                title="Key selected via the provider's normal rotation/health rules"
              >
                via {result.keyMask}
              </span>
            )}
          </div>
        )}
      </div>

      <ProviderErrorPanel providerId={provider.id} />
    </div>
  );
}

// Recent failed requests routed through this provider, so an operator can
// investigate without leaving the provider's page. Reuses the same
// DebugPanel/JsonTree drill-down as the Request Logs page.
function ProviderErrorPanel({ providerId }: { providerId: string }) {
  const [logs, setLogs] = useState<RequestLog[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLogs(await api.requestLogs({ providerId, error: "1", limit: 20 }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <FormSection
      title="Recent errors"
      desc="Failed requests routed through this provider — expand a row to inspect the captured request/response."
    >
      <div className="space-y-3 px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {logs ? `${logs.length} shown` : ""}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", loading && "animate-spin")}
            />
            Refresh
          </Button>
        </div>
        {!logs ? (
          <div className="overflow-hidden rounded-lg border border-border">
            <TableSkeleton
              rows={4}
              cols={5}
              widths={["45%", "55%", "30%", "35%", "70%"]}
            />
          </div>
        ) : logs.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No failed requests for this provider.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                  <TableHead className="text-right">Latency</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((l) => (
                  <ErrorLogRow key={l.id} log={l} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </FormSection>
  );
}

function ErrorLogRow({ log: l }: { log: RequestLog }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<RequestLogDetail | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = () => {
    if (!l.hasDebug) return;
    const next = !open;
    setOpen(next);
    if (next && detail === null && !loading) {
      setLoading(true);
      api
        .requestLogDetail(l.id)
        .then(setDetail)
        .catch(() => setDetail({ request: null, response: null }))
        .finally(() => setLoading(false));
    }
  };

  return (
    <>
      <TableRow className={cn(l.hasDebug && "cursor-pointer")} onClick={toggle}>
        <TableCell className="whitespace-nowrap text-muted-foreground">
          <span className="flex items-center gap-1.5">
            {l.hasDebug ? (
              <ChevronRight
                className={cn(
                  "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
                  open && "rotate-90",
                )}
              />
            ) : (
              <span className="w-3 shrink-0" />
            )}
            {fmtTime(l.ts)}
          </span>
        </TableCell>
        <TableCell className="max-w-[14rem] truncate font-mono text-primary">
          {l.model ?? "—"}
        </TableCell>
        <TableCell className="text-right">
          <StatusBadge status={l.status} />
        </TableCell>
        <TableCell className="text-right tabular-nums text-muted-foreground">
          {fmtLatency(l.latencyMs)}
        </TableCell>
        <TableCell className="max-w-[20rem] truncate text-amber-500 dark:text-amber-400">
          {l.error ?? ""}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={5} className="bg-muted/30 p-0">
            <div className="grid gap-4 p-4 md:grid-cols-2">
              <DebugPanel
                title="Request"
                subtitle="what the client sent the model"
                json={detail?.request}
                loading={loading}
              />
              <DebugPanel
                title="Response"
                subtitle="text, tool calls & stop reason"
                json={detail?.response}
                loading={loading}
              />
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
