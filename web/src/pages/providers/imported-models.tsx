// Per-provider imported-models page (/providers/:id/models).
//
// Imported models are the building blocks a chain references — they are NOT
// exposed on /v1/models. Here you import upstream ids into the provider's
// catalog, edit each one's metadata (display name, context window, max out,
// notes) and per-model transforms, and remove them.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus, Trash2, Download, Loader2, Check, X, Pencil } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Provider, ProviderModel, ModelTransformConfig } from "@/lib/types";
import {
  PageHeader,
  Spinner,
  EmptyState,
  Field,
  BackLink,
} from "@/components/shared";
import { ProviderIcon } from "@/components/model-icon";
import { TransformEditor } from "@/components/transform-editor";
import { Card } from "@/components/ui/card";
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
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { fmtTokens, plural } from "@/lib/utils";
import { cn } from "@/lib/utils";

export default function ImportedModels() {
  const { id = "" } = useParams();
  const [provider, setProvider] = useState<Provider | null>(null);
  const [items, setItems] = useState<ProviderModel[] | null>(null);
  const [editing, setEditing] = useState<ProviderModel | null>(null);
  const [importing, setImporting] = useState(false);

  const load = useCallback(() => {
    api
      .listProviders()
      .then((ps) => setProvider(ps.find((p) => p.id === id) ?? null))
      .catch(toast.error);
    api.listProviderModels(id).then(setItems).catch(toast.error);
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <BackLink to="/providers" label="Back to Providers" />
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            {provider && (
              <ProviderIcon
                brand={provider.catalogId}
                name={provider.name}
                className="size-5"
              />
            )}
            {provider?.name ?? id} · Imported Models
          </span>
        }
        desc="Upstream models available to reference in a fallback chain. Not exposed on /v1/models."
        meta={<Badge variant="secondary">{items?.length ?? 0} imported</Badge>}
        actions={
          <Button onClick={() => setImporting(true)}>
            <Download className="h-3.5 w-3.5" />
            Import from upstream
          </Button>
        }
      />

      <Card>
        {!items ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState msg="No imported models yet — import from upstream to build a catalog" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Upstream id</TableHead>
                <TableHead>Display name</TableHead>
                <TableHead className="text-right">Context</TableHead>
                <TableHead className="text-right">Max out</TableHead>
                <TableHead className="text-right">Transforms</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-mono text-primary">
                    {m.upstreamId}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {m.displayName ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m.contextWindow ? fmtTokens(m.contextWindow) : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m.maxOutputTokens ? fmtTokens(m.maxOutputTokens) : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m.transforms.length || "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setEditing(m)}
                        title="Edit"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <DeleteButton
                        providerId={id}
                        model={m}
                        onDeleted={load}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {editing && (
        <EditSheet
          providerId={id}
          model={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}

      {importing && provider && (
        <ImportSheet
          provider={provider}
          existing={new Set((items ?? []).map((m) => m.upstreamId))}
          onClose={() => setImporting(false)}
          onImported={() => {
            setImporting(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function DeleteButton({
  providerId,
  model,
  onDeleted,
}: {
  providerId: string;
  model: ProviderModel;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const del = async () => {
    if (!confirm(`Remove imported model '${model.upstreamId}'?`)) return;
    setBusy(true);
    try {
      await api.deleteProviderModel(providerId, model.id);
      toast.success("Removed");
      onDeleted();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="ghost" size="icon-sm" onClick={del} disabled={busy} title="Remove">
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Trash2 className="h-3.5 w-3.5 text-destructive" />
      )}
    </Button>
  );
}

// --- edit metadata + transforms (right-side sheet) --------------------------
function EditSheet({
  providerId,
  model,
  onClose,
  onSaved,
}: {
  providerId: string;
  model: ProviderModel;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState(model.displayName ?? "");
  const [contextWindow, setContextWindow] = useState(
    model.contextWindow?.toString() ?? "",
  );
  const [maxOut, setMaxOut] = useState(model.maxOutputTokens?.toString() ?? "");
  const [notes, setNotes] = useState(model.notes ?? "");
  const [transforms, setTransforms] = useState<ModelTransformConfig[]>(
    model.transforms,
  );
  const [saving, setSaving] = useState(false);

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
      });
      toast.success("Saved");
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="font-mono">{model.upstreamId}</SheetTitle>
          <SheetDescription>
            Imported model metadata + per-model transforms.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          <Field label="Display name">
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={model.upstreamId}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Context window" hint="base; a chain hop may override">
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
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>

          <div>
            <span className="mb-2 block text-xs font-medium text-foreground">
              Transforms
            </span>
            <TransformEditor value={transforms} onChange={setTransforms} />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>
              <X className="h-3.5 w-3.5" /> Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              Save
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// --- import picker (right-side sheet) ---------------------------------------
function ImportSheet({
  provider,
  existing,
  onClose,
  onImported,
}: {
  provider: Provider;
  existing: Set<string>;
  onClose: () => void;
  onImported: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [upstream, setUpstream] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .upstreamModels(provider.id)
      .then((r) => {
        setUpstream(r.models);
        if (r.error) toast.error(r.error);
      })
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setLoading(false));
  }, [provider.id]);

  const filtered = useMemo(
    () => upstream.filter((m) => m.toLowerCase().includes(filter.toLowerCase())),
    [upstream, filter],
  );

  const toggle = (m: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(m)) n.delete(m);
      else n.add(m);
      return n;
    });

  const run = async () => {
    setBusy(true);
    try {
      let created = 0;
      for (const upstreamId of selected) {
        if (existing.has(upstreamId)) continue;
        await api.createProviderModel(provider.id, { upstreamId });
        created++;
      }
      toast.success(plural(created, "model") + " imported");
      onImported();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Import from {provider.name}</SheetTitle>
          <SheetDescription>
            Pick upstream models to add to this provider's catalog.
          </SheetDescription>
        </SheetHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Fetching upstream models…
          </div>
        ) : upstream.length === 0 ? (
          <EmptyState msg="No upstream models discovered for this provider" />
        ) : (
          <>
            <div className="mt-4 flex items-center gap-2">
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter…"
                className="font-mono"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setSelected(new Set(upstream.filter((m) => !existing.has(m))))
                }
              >
                All new
              </Button>
            </div>
            <div className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto">
              {filtered.map((m) => {
                const have = existing.has(m);
                const on = selected.has(m);
                return (
                  <button
                    key={m}
                    type="button"
                    disabled={have}
                    onClick={() => toggle(m)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-mono transition-colors",
                      have
                        ? "cursor-not-allowed text-muted-foreground/50"
                        : on
                          ? "bg-primary/10 text-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded border",
                        on
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border",
                      )}
                    >
                      {on && <Check className="h-3 w-3" />}
                    </span>
                    {m}
                    {have && (
                      <Badge variant="secondary" className="ml-auto">
                        imported
                      </Badge>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Button variant="outline" onClick={onClose}>
                <X className="h-3.5 w-3.5" /> Cancel
              </Button>
              <Button onClick={run} disabled={busy || selected.size === 0}>
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                Import {selected.size || ""}
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
