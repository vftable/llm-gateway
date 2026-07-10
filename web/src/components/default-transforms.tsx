// Read-only preview of a provider's DEFAULT transform stack — what applies to
// every request through this provider automatically, before any per-model
// customization. Fetches GET /api/providers/:id/transforms/resolved (see
// src/admin/routes/resolved-transforms.ts and docs/transforms-api.md § "The
// default provider transform stack").
//
// Deliberately NON-EDITABLE: this is a window onto engine.ts's actual
// composition order (builtin all-provider hooks -> this adapter's own
// transforms -> the provider family's declared defaults), not a config
// surface — editing what a model does differently from its family default
// still happens in TransformEditor (the model's OWN transforms), which this
// panel sits above, clearly separated, so "what always happens" and "what
// I've customized" never look like the same kind of thing.
//
// Structure, same collapsible-card idiom as CapabilitiesEditor
// (models/shared.tsx): a header row (title + read-only badge + summary) that
// toggles the whole card open/closed, `bare` drops the outer chrome for a
// caller that already renders its own heading (the Imported Models
// row-expander). Inside, stages are grouped two ways to stay compact:
//   1. by phase (Request / Response / Stream) — always.
//   2. within a phase, consecutive stages sharing the same `source` AND
//      `group` (see ResolvedTransformStage.group) collapse into ONE row with
//      their own small disclosure, instead of one row per stage — e.g. the
//      four Anthropic request hooks read as "Anthropic request
//      normalization (4)" until expanded.

import { useEffect, useState } from "react";
import { ChevronRight, Info, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import type { ResolvedTransformStage, ResolvedTransforms } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

const SOURCE_LABEL: Record<ResolvedTransformStage["source"], string> = {
  builtin: "Built-in",
  adapter: "Adapter",
  family: "Family default",
  model: "Model",
};

const PHASE_LABEL: Record<"request" | "response" | "stream", string> = {
  request: "Request",
  response: "Response",
  stream: "Stream",
};

// Smooth height animation for every <CollapsibleContent> in this file —
// tw-animate-css's collapsible-down/up keyframes key off the
// --radix-collapsible-content-height custom property Radix sets automatically,
// so this is a drop-in className, not a hand-rolled transition. Same
// duration + S-curve as the sidebar's own nav-group collapse (layout.tsx) —
// it's the identical grid-height motion, just Radix-driven here.
const COLLAPSIBLE_CONTENT =
  "overflow-hidden duration-250 ease-sidebar data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up";

// Builtin/adapter stages carry only a raw stage name when no `label` was set
// at the declaration site (e.g. "anthropic:thinking-signature") — humanize
// the suffix after the LAST colon for display; the full name still shows as
// a title attribute so it's never fully hidden.
function humanizeStageName(name: string): string {
  const short = name.includes(":")
    ? name.slice(name.lastIndexOf(":") + 1)
    : name;
  return short
    .replace(/\s*\(.*\)\s*$/, "") // drop a trailing "(no-op)"-style suffix
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function displayName(stage: ResolvedTransformStage): string {
  return stage.label ?? humanizeStageName(stage.name);
}

// One resolved stage's params, rendered as compact inline chips.
function ParamChips({ params }: { params: Record<string, unknown> }) {
  const entries = Object.entries(params);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <code
          key={k}
          className="rounded bg-background px-1.5 py-0.5 font-mono text-[0.65rem] text-muted-foreground"
        >
          {k}={String(v)}
        </code>
      ))}
    </div>
  );
}

// A single stage's content (label + source badge + blurb + params) — shared
// between a standalone row and a row nested inside an expanded group.
function StageBody({ stage }: { stage: ResolvedTransformStage }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-foreground">
            {displayName(stage)}
          </span>
          <Badge
            variant={stage.source === "family" ? "default" : "secondary"}
            className="shrink-0 px-1.5 py-0 text-[0.65rem]"
          >
            {SOURCE_LABEL[stage.source]}
          </Badge>
        </div>
        {stage.blurb && (
          <p className="mt-0.5 text-[0.68rem] leading-snug text-muted-foreground">
            {stage.blurb}
          </p>
        )}
      </div>
      {stage.params && <ParamChips params={stage.params} />}
    </div>
  );
}

// A single, ungrouped stage — one compact row.
function StageRow({ stage }: { stage: ResolvedTransformStage }) {
  return (
    <div
      className="rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5"
      title={stage.name}
    >
      <StageBody stage={stage} />
    </div>
  );
}

// Multiple stages sharing a `group` — one collapsible row, closed by default,
// with a count badge and a combined title so the group reads as one
// conceptual unit ("Anthropic request normalization (4)") until expanded.
function StageGroupRow({ stages }: { stages: ResolvedTransformStage[] }) {
  const [open, setOpen] = useState(false);
  const first = stages[0];
  const label = first.group ?? displayName(first);
  const title = label
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-md border border-border/60 bg-muted/20"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left"
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <span className="text-xs font-medium text-foreground">{title}</span>
          <Badge
            variant={first.source === "family" ? "default" : "secondary"}
            className="shrink-0 px-1.5 py-0 text-[0.65rem]"
          >
            {SOURCE_LABEL[first.source]}
          </Badge>
          <span className="ml-auto shrink-0 text-[0.65rem] text-muted-foreground">
            {stages.length} stages
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(COLLAPSIBLE_CONTENT, "border-t border-border/60")}
      >
        <div className="space-y-1 px-2.5 py-1.5">
          {stages.map((s) => (
            <div key={s.name} title={s.name}>
              <StageBody stage={s} />
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// Cluster consecutive stages by (source, group) — a `group` is only ever
// meaningful within the same source (family/model stages don't set one), and
// consecutive-only keeps the original pipeline order intact (no reordering,
// just visual folding of adjacent same-group stages).
function clusterStages(
  stages: ResolvedTransformStage[],
): ResolvedTransformStage[][] {
  const clusters: ResolvedTransformStage[][] = [];
  for (const s of stages) {
    const last = clusters[clusters.length - 1];
    if (
      s.group &&
      last &&
      last[0].group === s.group &&
      last[0].source === s.source
    ) {
      last.push(s);
    } else {
      clusters.push([s]);
    }
  }
  return clusters;
}

function PhaseSection({
  phase,
  stages,
}: {
  phase: "request" | "response" | "stream";
  stages: ResolvedTransformStage[];
}) {
  if (stages.length === 0) return null;
  const clusters = clusterStages(stages);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[0.65rem] font-medium tracking-wide text-muted-foreground uppercase">
          {PHASE_LABEL[phase]}
        </span>
        <span className="text-[0.65rem] text-muted-foreground/70">
          {stages.length}
        </span>
      </div>
      <div className="space-y-1">
        {clusters.map((cluster) =>
          cluster.length > 1 ? (
            <StageGroupRow key={cluster[0].name} stages={cluster} />
          ) : (
            <StageRow key={cluster[0].name} stage={cluster[0]} />
          ),
        )}
      </div>
    </div>
  );
}

export function DefaultTransformsPanel({
  providerId,
  upstreamId,
  bare = false,
  defaultOpen = false,
}: {
  providerId: string;
  /** When given, layers that specific imported model's own transforms on top
   *  (shows what's overridden), same as a live request would resolve them. */
  upstreamId?: string;
  bare?: boolean;
  /** Whether the (non-bare) card starts expanded. Default collapsed — this
   *  panel is a reference an operator checks occasionally, not something
   *  that needs to dominate the page on every load. */
  defaultOpen?: boolean;
}) {
  const [data, setData] = useState<ResolvedTransforms | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .resolvedTransforms(providerId, upstreamId)
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [providerId, upstreamId]);

  const total = data
    ? data.request.length + data.response.length + data.stream.length
    : 0;

  const body = loading ? (
    <div className="space-y-1.5 px-4 py-3">
      <Skeleton className="h-7 w-full" />
      <Skeleton className="h-7 w-full" />
    </div>
  ) : error ? (
    <p className="px-4 py-3 text-xs text-destructive">
      Couldn't load default transforms: {error}
    </p>
  ) : !data || total === 0 ? (
    <p className="px-4 py-3 text-xs text-muted-foreground">
      This provider has no default transforms — requests forward as converted,
      with no automatic body changes.
    </p>
  ) : (
    <div className="space-y-3 px-4 py-3">
      <PhaseSection phase="request" stages={data.request} />
      <PhaseSection phase="response" stages={data.response} />
      <PhaseSection phase="stream" stages={data.stream} />
      {data.overridden.length > 0 && (
        <div className="flex items-start gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-2.5 py-1.5 text-[0.7rem] text-muted-foreground">
          <Info className="mt-0.5 h-3 w-3 shrink-0 text-primary" />
          <span>
            This model overrides{" "}
            {data.overridden.map((s, i) => (
              <span key={s.name}>
                {i > 0 && ", "}
                <span className="font-medium text-foreground">
                  {displayName(s)}
                </span>
              </span>
            ))}{" "}
            in the Custom transforms section below.
          </span>
        </div>
      )}
    </div>
  );

  const summary = loading ? (
    <Loader2 className="inline h-3 w-3 animate-spin" />
  ) : total > 0 ? (
    `${total} applied automatically`
  ) : (
    "None"
  );

  if (bare) {
    // Nested inside an already-expanded parent that renders its OWN "Default
    // transforms" heading right above this (the imported-model row) — the
    // trigger text here deliberately doesn't repeat that label, just the
    // count, so the two don't read as duplicate headings stacked on top of
    // each other. A second layer of card chrome is unnecessary here too, but
    // the content can still be long, so this still gets its own lightweight
    // disclosure instead of always rendering fully open and pushing the rest
    // of the row down.
    return (
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-border/60 bg-muted/10 px-3 py-2 text-left hover:bg-muted/20"
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
            <span className="text-xs font-medium text-foreground">
              {loading
                ? "Loading…"
                : total > 0
                  ? `Show ${total} stage${total === 1 ? "" : "s"}`
                  : "None applied"}
            </span>
            {data && data.overridden.length > 0 && (
              <Badge variant="default" className="ml-auto shrink-0">
                {data.overridden.length} overridden
              </Badge>
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className={COLLAPSIBLE_CONTENT}>
          <div className="mt-1.5 rounded-md border border-border/60">
            {body}
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-lg border border-border bg-card"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full cursor-pointer items-center justify-between gap-3 px-5 py-4 text-left"
        >
          <span className="flex min-w-0 shrink-0 items-center gap-2 text-sm font-medium text-foreground">
            <ChevronRight
              className={cn(
                "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
            <span>Default transforms</span>
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[0.65rem] font-medium text-muted-foreground">
              Read-only
            </span>
          </span>
          <span className="min-w-0 truncate text-right text-[0.65rem] text-muted-foreground">
            {summary}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(COLLAPSIBLE_CONTENT, "border-t border-border")}
      >
        {body}
      </CollapsibleContent>
    </Collapsible>
  );
}
