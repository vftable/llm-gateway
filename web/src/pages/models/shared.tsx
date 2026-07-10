// Shared model-editor pieces used by both the models list and the routed model
// editor page: endpoint helpers, the per-hop conversion badge, and the
// capabilities editor.

import type { ReactNode } from "react";
import { Sparkles } from "lucide-react";
import type { ModelCapabilities, Provider } from "@/lib/types";
import { Switch } from "@/components/ui/switch";
import { cn, conversionLabel, conversionHelp } from "@/lib/utils";

// One editable fallback-chain hop. Every hop always routes through the
// provider's own native format — no per-hop endpoint pin — and the context-
// window skip check always uses the imported ProviderModel's own window.
export interface ChainRow {
  providerId: string;
  upstreamModel: string;
  enabled: boolean;
}

// Short endpoint tag for the list-row chain badges (legacy per-hop endpoint
// pins, still readable for models saved before this field was removed).
export function endpointShort(ep: string): string {
  if (ep.endsWith("/messages")) return "msg";
  if (ep.endsWith("/responses")) return "resp";
  if (ep.endsWith("/chat/completions")) return "chat";
  return ep;
}

export type Wire = "messages" | "chat" | "responses";

// Per-hop conversion indicator. Every hop routes through the provider's own
// native format now (no per-hop endpoint pin), so this just compares the
// client's format against the provider's. Plain text + dot rather than a
// pill badge — this sits inline in a row of controls, not a standalone chip.
export function HopConversionBadge({
  provider,
  modelType,
}: {
  provider: Provider;
  modelType: string;
}) {
  const clientFmt: Wire = modelType === "anthropic" ? "messages" : "chat";
  if (provider.nativeConversion) {
    return (
      <span
        className="inline-flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap text-foreground"
        title={conversionHelp(true)}
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
        <span className="truncate">{conversionLabel(true)}</span>
      </span>
    );
  }
  const hopFmt: Wire = provider.format === "anthropic" ? "messages" : "chat";
  const converts = clientFmt !== hopFmt;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap",
        converts ? "text-amber-600 dark:text-amber-400" : "text-foreground",
      )}
      title={
        converts
          ? `Gateway converts ${clientFmt} → ${hopFmt} for this hop.`
          : "Same wire format — no conversion for this hop."
      }
    >
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          converts ? "bg-amber-500" : "bg-muted-foreground",
        )}
      />
      <span className="truncate">
        {converts ? `Gateway converts → ${hopFmt}` : "No conversion"}
      </span>
    </span>
  );
}

// Compact capability editor: pill toggles for boolean capabilities plus
// thinking-type and effort-level pickers. When `locked`, the alias matches an
// official Anthropic model and the server pins capabilities to the stock entry.
// `bare` drops the outer card border + "Capabilities" title/summary header —
// for callers that already render their own heading around this (e.g. the
// Imported Models row-expander), so the two don't stack as duplicate labels.
export function CapabilitiesEditor({
  caps,
  onChange,
  locked = false,
  bare = false,
}: {
  caps: ModelCapabilities;
  onChange: (c: ModelCapabilities) => void;
  locked?: boolean;
  bare?: boolean;
}) {
  const FLAGS: Array<{ key: keyof ModelCapabilities; label: string }> = [
    { key: "batch", label: "Batch" },
    { key: "citations", label: "Citations" },
    { key: "code_execution", label: "Code execution" },
    { key: "image_input", label: "Image input" },
    { key: "pdf_input", label: "PDF input" },
    { key: "structured_outputs", label: "Structured outputs" },
  ];
  const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

  const flagOn = (k: keyof ModelCapabilities) =>
    (caps[k] as { supported: boolean }).supported;
  const setFlag = (k: keyof ModelCapabilities, v: boolean) =>
    onChange({ ...caps, [k]: { supported: v } });

  // `dim` = this pill's whole SECTION is off (thinking/effort supported:false)
  // — distinct from `locked` (an admin-level pin). A dimmed pill is still
  // disabled, but stays visible at reduced opacity instead of disappearing,
  // so re-enabling the section restores exactly what was selected before —
  // nothing is lost, only hidden from interaction while inactive.
  const pill = (
    on: boolean,
    label: string,
    toggle: () => void,
    dim = false,
  ) => (
    <button
      key={label}
      type="button"
      disabled={locked || dim}
      onClick={toggle}
      className={cn(
        "rounded-md border px-2.5 py-1 text-xs transition-colors",
        locked || dim ? "cursor-default" : "cursor-pointer",
        on
          ? "border-primary/30 bg-primary/10 text-primary"
          : locked
            ? "border-border text-muted-foreground/50"
            : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground",
        dim && "opacity-50",
      )}
    >
      {label}
    </button>
  );

  const subPanel = (
    label: string,
    checked: boolean,
    onToggle: (v: boolean) => void,
    content: ReactNode,
  ) => (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex items-center gap-2.5">
        <Switch
          checked={checked}
          disabled={locked}
          onCheckedChange={onToggle}
        />
        <span className="text-xs font-medium text-foreground">{label}</span>
      </div>
      {/* Always rendered (not gated on `checked`) so turning the section off
          dims its sub-selections instead of discarding them from view. */}
      <div className="mt-2.5 flex flex-wrap gap-2">{content}</div>
    </div>
  );

  const summary = [
    ...FLAGS.filter((f) => flagOn(f.key)).map((f) => f.label),
    caps.thinking.supported ? "Thinking" : null,
    caps.effort.supported ? "Effort" : null,
  ].filter(Boolean);

  const body = (
    <div
      className={cn("space-y-4", !bare && "border-t border-border px-5 py-4")}
    >
      {locked && (
        <p className="text-[0.65rem] text-muted-foreground">
          This alias matches an official Anthropic model, so its thinking types,
          effort levels and other capabilities are pinned to the Anthropic API's
          own metadata and can't be overridden.
        </p>
      )}

      <div>
        <span className="mb-2 block text-[0.65rem] font-medium tracking-wide text-muted-foreground uppercase">
          Features
        </span>
        <div className="flex flex-wrap gap-2">
          {FLAGS.map((f) =>
            pill(flagOn(f.key), f.label, () => setFlag(f.key, !flagOn(f.key))),
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {subPanel(
          "Thinking",
          caps.thinking.supported,
          (v) =>
            onChange({
              ...caps,
              thinking: { ...caps.thinking, supported: v },
            }),
          (["adaptive", "enabled"] as const).map((t) =>
            pill(
              caps.thinking.types[t].supported,
              t,
              () =>
                onChange({
                  ...caps,
                  thinking: {
                    ...caps.thinking,
                    types: {
                      ...caps.thinking.types,
                      [t]: { supported: !caps.thinking.types[t].supported },
                    },
                  },
                }),
              !caps.thinking.supported,
            ),
          ),
        )}

        {subPanel(
          "Effort levels",
          caps.effort.supported,
          (v) =>
            onChange({
              ...caps,
              effort: { ...caps.effort, supported: v },
            }),
          EFFORTS.map((e) =>
            pill(
              caps.effort[e].supported,
              e,
              () =>
                onChange({
                  ...caps,
                  effort: {
                    ...caps.effort,
                    [e]: { supported: !caps.effort[e].supported },
                  },
                }),
              !caps.effort.supported,
            ),
          ),
        )}
      </div>
    </div>
  );

  if (bare) return body;

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex w-full items-center justify-between gap-3 px-5 py-4">
        <span className="flex shrink-0 items-center gap-2 text-sm font-medium text-foreground">
          <span>Capabilities</span>
          {locked && (
            <span className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[0.65rem] font-medium text-primary">
              <Sparkles className="h-3 w-3" />
              Synced with Anthropic
            </span>
          )}
        </span>
        <span className="min-w-0 truncate text-right text-[0.65rem] text-muted-foreground">
          {summary.length ? summary.join(" · ") : "None set"}
        </span>
      </div>
      {body}
    </div>
  );
}
