// Step 3: test connectivity — the trigger button lives in the dialog footer;
// this is just the idle hint + async result.

import { Check, Loader2 } from "lucide-react";
import type { ProviderTestProbe, WireKind } from "@/lib/types";
import { cn, resolvedUrlPreview } from "@/lib/utils";

export function TestStep({
  testing,
  probe,
  baseUrl,
  basePath,
  modelsPath,
  endpoints,
  endpointPaths,
}: {
  testing: boolean;
  probe: ProviderTestProbe | null;
  baseUrl: string;
  basePath: string;
  modelsPath: string;
  endpoints?: WireKind[];
  endpointPaths?: Partial<Record<WireKind, string>>;
}) {
  // The connectivity test hits the model-list endpoint (origin + basePath +
  // modelsPath — same composition modelsUrl() uses server-side in routes.ts),
  // not a completion endpoint. Shown here so the preview matches exactly what
  // gets probed.
  const origin = (baseUrl || "").replace(/\/+$/, "");
  const modelsUrl = origin ? origin + (basePath || "") + modelsPath : "";
  return (
    // Top-anchored like every other step (Configure, Import) — a step that
    // only centers itself when its own content is short reads as an odd
    // vertical jump the instant a result appears and the block re-centers.
    // Left-aligned throughout so the URLs and result read as a clean
    // top-down flow instead of a centered blob.
    <div className="space-y-4 py-2">
      <div className="space-y-1.5">
        <div className="text-sm text-muted-foreground">
          Test connectivity to{" "}
          <span className="font-mono break-all text-foreground">
            {modelsUrl || "—"}
          </span>
        </div>
        {endpoints && endpoints.length > 0 && (
          <p className="text-[0.7rem] text-muted-foreground">
            Requests will route to{" "}
            <span className="font-mono break-all">
              {resolvedUrlPreview(
                baseUrl,
                basePath,
                endpoints[0],
                endpointPaths,
              )}
            </span>
          </p>
        )}
      </div>

      {/* The "Test" button lives in the dialog footer (shared with Skip/
          Import so the primary actions stay in one place) — this is just the
          idle hint + the async result, not a second trigger for the same
          action. */}
      {!probe && !testing && (
        <p className="text-xs text-muted-foreground">
          Click <span className="font-medium text-foreground">Test</span> below
          to check connectivity — it isn't required, you can skip and create the
          provider anyway.
        </p>
      )}
      {testing && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground animate-in fade-in-0 duration-200">
          <Loader2 className="h-4 w-4 animate-spin" /> Testing…
        </div>
      )}
      {probe && (
        <div className="space-y-2 animate-in fade-in-0 slide-in-from-top-1 duration-200">
          <div
            className={cn(
              "flex items-center gap-2 rounded-lg border p-3 text-sm",
              probe.ok
                ? "border-success/40 bg-success/10 text-foreground"
                : "border-destructive/40 bg-destructive/10 text-foreground",
            )}
          >
            {probe.ok ? (
              <>
                <Check className="h-4 w-4 shrink-0 text-success" />
                <span>
                  Reachable · {probe.ms}ms
                  {probe.models.length > 0 &&
                    ` · ${probe.models.length} models`}
                </span>
              </>
            ) : (
              <span>Failed — {probe.error || `status ${probe.status}`}</span>
            )}
          </div>
          {probe.keyMask && (
            <p
              className="text-[0.7rem] text-muted-foreground"
              title="Key selected via the provider's normal rotation/health rules — the same pick a live request would use"
            >
              Tested with key{" "}
              <span className="font-mono text-foreground">{probe.keyMask}</span>
            </p>
          )}
          <p className="text-[0.7rem] text-muted-foreground">
            The test isn't required — you can skip and create the provider
            anyway.
          </p>
        </div>
      )}
    </div>
  );
}
