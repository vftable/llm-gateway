// One imported-model row: collapsed summary + inline expanded editor
// (metadata + transforms + capabilities), plus per-row test/delete actions.

import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Trash2,
  Loader2,
  Check,
  X,
  ChevronRight,
  FlaskConical,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type {
  Model,
  ProviderModel,
  ModelTransformConfig,
  ModelCapabilities,
  TestModelResult,
} from "@/lib/types";
import { DEFAULT_CAPABILITIES } from "@/lib/types";
import { CapabilitiesEditor } from "../../models/shared";
import { Field } from "@/components/shared";
import { TransformEditor } from "@/components/transform-editor";
import { DefaultTransformsPanel } from "@/components/default-transforms";
import { TableCell, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { fmtTokens, cn } from "@/lib/utils";

// TestModelResult.data on failure carries the upstream's own error body
// verbatim ("the operator sees the REAL error rather than a generic 'test
// failed'" — see the type's own doc comment) — this renders it compactly for
// the tooltip. `data` is `unknown`: a string passes through as-is; an object
// (the common case — a parsed JSON error body) is stringified; anything else
// (undefined, a number) is dropped rather than shown as "undefined"/"null".
function summarizeTestData(data: unknown): string | null {
  if (data == null) return null;
  if (typeof data === "string") return data.slice(0, 200);
  if (typeof data === "object") {
    try {
      return JSON.stringify(data).slice(0, 200);
    } catch {
      return null;
    }
  }
  return null;
}

export function ModelRow({
  providerId,
  model,
  usedBy,
  selected,
  onToggleSel,
  onChanged,
}: {
  providerId: string;
  model: ProviderModel;
  usedBy: Model[];
  selected: boolean;
  onToggleSel: () => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState(model.displayName ?? "");
  const [contextWindow, setContextWindow] = useState(
    model.contextWindow?.toString() ?? "",
  );
  const [maxOut, setMaxOut] = useState(model.maxOutputTokens?.toString() ?? "");
  const [notes, setNotes] = useState(model.notes ?? "");
  const [transforms, setTransforms] = useState<ModelTransformConfig[]>(
    model.transforms,
  );
  const [capabilities, setCapabilities] = useState<ModelCapabilities | null>(
    model.capabilities,
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestModelResult | null>(null);

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.testProviderModel(providerId, model.id);
      setTestResult(r);
      if (r.ok) toast.success(`${model.upstreamId} reachable · ${r.ms}ms`);
      else
        toast.error(
          `${model.upstreamId} test failed${r.status ? ` (${r.status})` : ""}`,
        );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const dirty =
    displayName !== (model.displayName ?? "") ||
    contextWindow !== (model.contextWindow?.toString() ?? "") ||
    maxOut !== (model.maxOutputTokens?.toString() ?? "") ||
    notes !== (model.notes ?? "") ||
    JSON.stringify(transforms) !== JSON.stringify(model.transforms) ||
    JSON.stringify(capabilities) !== JSON.stringify(model.capabilities);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateProviderModel(providerId, model.id, {
        upstreamId: model.upstreamId,
        displayName: displayName || null,
        contextWindow: contextWindow ? Number(contextWindow) : null,
        maxOutputTokens: maxOut ? Number(maxOut) : null,
        notes: notes || null,
        transforms,
        capabilities,
      });
      toast.success("Saved");
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    if (!confirm(`Remove imported model '${model.upstreamId}'?`)) return;
    setDeleting(true);
    try {
      await api.deleteProviderModel(providerId, model.id);
      toast.success("Removed");
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <TableRow
        className={cn("group cursor-pointer", open && "border-b-0")}
        onClick={() => setOpen((o) => !o)}
      >
        <TableCell onClick={(e) => e.stopPropagation()}>
          <Checkbox
            aria-label={`Select ${model.upstreamId}`}
            checked={selected}
            onCheckedChange={onToggleSel}
          />
        </TableCell>
        <TableCell className="font-mono text-primary">
          <span className="flex min-w-0 items-center gap-1.5">
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
            <span className="truncate" title={model.upstreamId}>
              {model.upstreamId}
            </span>
          </span>
        </TableCell>
        <TableCell className="text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate" title={model.displayName ?? undefined}>
              {model.displayName ?? "—"}
            </span>
            {model.capabilities && (
              <Badge
                variant="secondary"
                className="shrink-0 opacity-70"
                title="Capabilities imported from the provider"
              >
                caps
              </Badge>
            )}
          </span>
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {model.contextWindow ? fmtTokens(model.contextWindow) : "—"}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {model.maxOutputTokens ? fmtTokens(model.maxOutputTokens) : "—"}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {model.transforms.length || "—"}
        </TableCell>
        <TableCell onClick={(e) => e.stopPropagation()}>
          {usedBy.length === 0 ? (
            <span className="text-xs text-muted-foreground">—</span>
          ) : (
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              {usedBy.slice(0, 2).map((m) => (
                <Link
                  key={m.id}
                  to={`/models/${m.id}`}
                  className={cn(
                    buttonVariants({ variant: "secondary", size: "sm" }),
                    "max-w-40 truncate",
                  )}
                  title={`Edit ${m.alias}`}
                >
                  {m.alias}
                </Link>
              ))}
              {usedBy.length > 2 && (
                <Badge
                  variant="secondary"
                  title={usedBy
                    .slice(2)
                    .map((m) => m.alias)
                    .join(", ")}
                >
                  +{usedBy.length - 2}
                </Badge>
              )}
            </span>
          )}
        </TableCell>
        <TableCell onClick={(e) => e.stopPropagation()}>
          <span className="flex items-center justify-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={runTest}
                  disabled={testing}
                  aria-label={`Test ${model.upstreamId}`}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {testing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FlaskConical
                      className={cn(
                        "h-3.5 w-3.5",
                        testResult &&
                          (testResult.ok ? "text-success" : "text-destructive"),
                      )}
                    />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-64">
                {testResult ? (
                  testResult.ok ? (
                    `Reachable · ${testResult.ms}ms`
                  ) : (
                    <>
                      Failed
                      {testResult.status ? ` (${testResult.status})` : ""}
                      {summarizeTestData(testResult.data) && (
                        <span className="mt-0.5 block font-mono text-[0.65rem] break-words opacity-80">
                          {summarizeTestData(testResult.data)}
                        </span>
                      )}
                    </>
                  )
                ) : (
                  `Send a test request to ${model.upstreamId}`
                )}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={del}
                  disabled={deleting}
                  aria-label={`Remove ${model.upstreamId}`}
                  className="text-muted-foreground hover:text-destructive"
                >
                  {deleting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Remove {model.upstreamId}</TooltipContent>
            </Tooltip>
          </span>
        </TableCell>
      </TableRow>

      {open && (
        <TableRow className="bg-muted/20 hover:bg-muted/20">
          <TableCell colSpan={8} className="py-4">
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Field label="Display name">
                  <Input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder={model.upstreamId}
                  />
                </Field>
                <Field label="Context window">
                  <Input
                    type="number"
                    value={contextWindow}
                    onChange={(e) => setContextWindow(e.target.value)}
                    placeholder="e.g. 200000"
                  />
                </Field>
                <Field label="Max output tokens">
                  <Input
                    type="number"
                    value={maxOut}
                    onChange={(e) => setMaxOut(e.target.value)}
                    placeholder="e.g. 128000"
                  />
                </Field>
              </div>
              <Field label="Notes">
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </Field>
              <div>
                <span className="mb-2 block text-xs font-medium text-foreground">
                  Default transforms{" "}
                  <span className="font-normal text-muted-foreground">
                    · always applied by this provider, not editable here
                  </span>
                </span>
                <DefaultTransformsPanel
                  providerId={providerId}
                  upstreamId={model.upstreamId}
                  bare
                />
              </div>
              <div>
                <span className="mb-2 block text-xs font-medium text-foreground">
                  Custom transforms{" "}
                  <span className="font-normal text-muted-foreground">
                    · this model's own additions, layered on top of the defaults
                    above
                  </span>
                </span>
                <TransformEditor value={transforms} onChange={setTransforms} />
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-foreground">
                    Capabilities{" "}
                    <span className="font-normal text-muted-foreground">
                      · metadata for this imported model
                    </span>
                  </span>
                  {capabilities ? (
                    <Button
                      type="button"
                      variant="link"
                      onClick={() => setCapabilities(null)}
                      className="h-auto p-0 text-[0.7rem] text-muted-foreground hover:text-destructive hover:no-underline"
                    >
                      Clear
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="link"
                      onClick={() => setCapabilities(DEFAULT_CAPABILITIES)}
                      className="h-auto p-0 text-[0.7rem]"
                    >
                      + Add capabilities
                    </Button>
                  )}
                </div>
                {capabilities ? (
                  <CapabilitiesEditor
                    caps={capabilities}
                    onChange={setCapabilities}
                    bare
                  />
                ) : (
                  <p className="text-[0.7rem] text-muted-foreground">
                    None set. Imported from the provider when reported, or add
                    them manually.
                  </p>
                )}
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setOpen(false)}
                >
                  <X className="h-3.5 w-3.5" />
                  Close
                </Button>
                <Button size="sm" onClick={save} disabled={saving || !dirty}>
                  {saving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  Save
                </Button>
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
