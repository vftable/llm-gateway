import { memo, useMemo, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import type { RequestLog, RequestLogDetail } from "@/lib/types";
import { useWsSubscription } from "@/hooks/use-ws";
import {
  PageHeader,
  TableSkeleton,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import { cn, fmtTime, fmtNum } from "@/lib/utils";
import {
  ModelIcon,
  useModelTypes,
  brandForProvider,
} from "@/components/model-icon";
import {
  DebugPanel,
  StatusBadge,
  fmtLatency,
} from "@/components/request-log-debug";

const PAGE_SIZE = 50;

// Future-tense countdown for a throttle row's retry epoch (ms): "retry in 45s"
// / "retry in 3m" — or "retry now" once it has lapsed (the row hasn't re-fetched
// since the cooldown cleared). relTime is past-tense only, so this is separate.
function retryHint(retryAtMs: number): string {
  const s = Math.round((retryAtMs - Date.now()) / 1000);
  if (s <= 0) return "retry now";
  if (s < 60) return `retry in ${s}s`;
  if (s < 3600) return `retry in ${Math.floor(s / 60)}m`;
  return `retry in ${Math.floor(s / 3600)}h`;
}

export default function RequestLogs() {
  const [model, setModel] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [page, setPage] = useState(0);
  const modelTypes = useModelTypes();

  // reset to the first page whenever filters change
  useEffect(() => {
    setPage(0);
  }, [model, errorsOnly]);

  const wsParams = useMemo(
    () => ({
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      ...(model ? { model } : {}),
      ...(errorsOnly ? { error: "1" as const } : {}),
    }),
    [model, errorsOnly, page],
  );
  const { data: items } = useWsSubscription<RequestLog[]>(
    "request-logs",
    wsParams,
  );

  return (
    <div>
      <PageHeader
        title="Request Logs"
        desc="Per-request activity — real-time via WebSocket"
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
            <TableSkeleton
              rows={8}
              cols={9}
              widths={[
                "60%",
                "40%",
                "45%",
                "70%",
                "60%",
                "30%",
                "35%",
                "30%",
                "50%",
              ]}
            />
          ) : items.length === 0 && page === 0 ? (
            <EmptyState msg="No matching requests" />
          ) : (
            <Table className="table-fixed min-w-[64rem]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[9%]">Time</TableHead>
                  <TableHead className="w-[9%]">Key</TableHead>
                  <TableHead className="w-[9%]">Client</TableHead>
                  <TableHead className="w-[18%]">Model</TableHead>
                  <TableHead className="w-[20%]">Provider</TableHead>
                  <TableHead className="w-[7%] text-right">Status</TableHead>
                  <TableHead className="w-[10%] text-right">
                    Tok In/Out
                  </TableHead>
                  <TableHead className="w-[7%] text-right">Latency</TableHead>
                  <TableHead className="w-[11%]">Note</TableHead>
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

// Known client brands for icon matching — keys are the lowercase labels
// detectClient() returns (see gateway/client-detect.ts).
const CLIENT_BRANDS: Record<string, string> = {
  "claude code": "claude",
  codex: "openai",
  copilot: "openai",
  postman: "postman",
  cursor: "cursor",
  opencode: "opencode",
};

function capitalizeClient(name: string): string {
  const KNOWN: Record<string, string> = {
    "claude code": "Claude Code",
    "openai sdk": "OpenAI SDK",
    "anthropic sdk": "Anthropic SDK",
    "open webui": "Open WebUI",
    "roo code": "Roo Code",
    "kilo code": "Kilo Code",
    "gemini cli": "Gemini CLI",
    "qwen code": "Qwen Code",
    "cherry studio": "Cherry Studio",
    lobechat: "LobeChat",
    librechat: "LibreChat",
    litellm: "LiteLLM",
    langchain: "LangChain",
    llamaindex: "LlamaIndex",
    chatbox: "ChatBox",
    postman: "Postman",
    insomnia: "Insomnia",
    curl: "cURL",
  };
  return (
    KNOWN[name] ??
    name
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ")
  );
}

function ClientBadge({ name }: { name: string }) {
  const brand = brandForProvider(CLIENT_BRANDS[name] ?? null, name);
  return (
    <Badge
      variant="secondary"
      className="inline-flex max-w-full items-center gap-1.5 truncate"
    >
      {brand && (
        <span
          className="inline-flex size-3 shrink-0 items-center justify-center [&>svg]:size-full"
          dangerouslySetInnerHTML={{ __html: brand.svg }}
        />
      )}
      <span className="truncate">{capitalizeClient(name)}</span>
    </Badge>
  );
}

const LogRow = memo(function LogRow({
  log: l,
  type,
}: {
  log: RequestLog;
  type: string | undefined;
}) {
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
        <TableCell className="truncate text-muted-foreground">
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
            <ClientBadge name={l.client} />
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
        <TableCell className="min-w-0 font-mono text-primary">
          {l.model ? (
            <span className="flex min-w-0 items-center gap-2">
              <ModelIcon alias={l.model} type={type} />
              <span className="truncate">{l.model}</span>
            </span>
          ) : (
            "—"
          )}
        </TableCell>
        <TableCell className="min-w-0">
          <div className="min-w-0">
            <span className="block truncate font-medium text-foreground">
              {l.providerName ?? l.providerId ?? "—"}
            </span>
            {(l.upstreamModel || l.upstreamKeyMask) && (
              <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                {l.upstreamModel && (
                  <span className="min-w-0 truncate font-mono">
                    {l.upstreamModel}
                  </span>
                )}
                {l.upstreamKeyMask && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="shrink-0">
                        <Badge variant="secondary" className="font-mono">
                          {l.upstreamKeyMask}
                        </Badge>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      Upstream provider key used for this request
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            )}
          </div>
        </TableCell>
        <TableCell className="text-right">
          <div className="flex flex-col items-end gap-0.5">
            <StatusBadge status={l.status} throttled={l.throttled} />
            {l.throttled && l.retryAt && (
              <span className="text-[0.6rem] text-muted-foreground">
                {retryHint(l.retryAt)}
              </span>
            )}
          </div>
        </TableCell>
        <TableCell className="text-right tabular-nums text-muted-foreground">
          {l.inputTokens != null || l.outputTokens != null
            ? `${fmtNum(l.inputTokens)}/${fmtNum(l.outputTokens)}`
            : "—"}
          {l.stream && (
            <span className="ml-1 text-[0.6rem] text-primary">stream</span>
          )}
          {l.cachedTokens != null && l.cachedTokens > 0 && (
            <span
              className="block text-[0.6rem] text-muted-foreground/70"
              title="Prompt tokens served from cache"
            >
              {fmtNum(l.cachedTokens)} cached
            </span>
          )}
        </TableCell>
        <TableCell className="text-right tabular-nums text-muted-foreground">
          {fmtLatency(l.latencyMs)}
        </TableCell>
        <TableCell
          className="truncate text-amber-500 dark:text-amber-400"
          title={l.error ?? undefined}
        >
          {l.error ?? ""}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={9} className="bg-muted/30 p-0">
            <div className="grid gap-3 p-3 md:grid-cols-2">
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
});
