// Shared request-log debug UI: the status badge, latency formatter, and the
// captured-JSON drill-down panel. Used by the Request Logs page and by any
// page-scoped error panel (e.g. a provider's own recent-failures view).

import { Badge } from "@/components/ui/badge";
import { JsonTree } from "@/components/json-tree";
import { cn } from "@/lib/utils";

export function fmtLatency(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

export function StatusBadge({ status }: { status: number | null }) {
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

// Show a captured JSON blob as an interactive, syntax-highlighted tree (or a
// fallback while loading / when nothing was captured). The blob is already
// truncated server-side; the tree parses it and lets you open/close nodes.
export function DebugPanel({
  title,
  subtitle,
  json,
  loading,
}: {
  title: string;
  subtitle: string;
  json: string | null | undefined;
  loading: boolean;
}) {
  const copy = () => {
    if (!json) return;
    let text = json;
    try {
      text = JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      /* copy raw on parse failure */
    }
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-semibold text-foreground">{title}</span>
          <span className="text-[0.6rem] text-muted-foreground">
            {subtitle}
          </span>
        </div>
        {json && (
          <button
            type="button"
            onClick={copy}
            className="text-[0.6rem] text-muted-foreground transition-colors hover:text-foreground"
          >
            copy
          </button>
        )}
      </div>
      <div className="max-h-96 overflow-auto rounded-md border border-border bg-background p-3">
        {loading ? (
          <span className="font-mono text-[0.7rem] text-muted-foreground">
            loading…
          </span>
        ) : !json ? (
          <span className="font-mono text-[0.7rem] text-muted-foreground">
            — not captured —
          </span>
        ) : (
          <JsonTree json={json} />
        )}
      </div>
    </div>
  );
}
