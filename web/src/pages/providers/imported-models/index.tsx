// Per-provider imported-models page (/providers/:id/imported).
//
// Imported models are the building blocks a chain references — they are NOT
// exposed on /v1/models. This page is built for fast management:
//   - a quick "add upstream ID" bar (no sheet round-trip)
//   - inline row-expand editing (metadata + transforms) — no context switch
//   - multi-select + bulk delete
//   - a "used by" column linking to the exposed models that reference each one
//   - the "import from upstream" discovery sheet (bulk pick many at once)
//
// Split across sibling files by concern:
//   add-model-dialog.tsx — AddModelDialog (quick add-by-id)
//   model-row.tsx         — ModelRow (collapsed summary + inline editor)
//   import-sheet.tsx      — ImportSheet (upstream discovery + bulk import)

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus, Trash2, Download } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Model, Provider, ProviderModel } from "@/lib/types";
import {
  PageHeader,
  TableSkeleton,
  EmptyState,
  BackLink,
  TableSearch,
} from "@/components/shared";
import { ProviderIcon } from "@/components/model-icon";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { plural } from "@/lib/utils";
import { AddModelDialog } from "./add-model-dialog";
import { ModelRow } from "./model-row";
import { ImportSheet } from "./import-sheet";

export default function ImportedModels() {
  const { id = "" } = useParams();
  const [provider, setProvider] = useState<Provider | null>(null);
  const [items, setItems] = useState<ProviderModel[] | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState("");

  const load = useCallback(() => {
    api
      .listProviders()
      .then((ps) => setProvider(ps.find((p) => p.id === id) ?? null))
      .catch(toast.error);
    api.listProviderModels(id).then(setItems).catch(toast.error);
    api
      .listModels()
      .then(setModels)
      .catch(() => {});
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  // Which exposed models reference each imported upstream id (for "used by").
  const usedBy = useMemo(() => {
    const map = new Map<string, Model[]>();
    for (const m of models)
      for (const link of m.providers)
        if (link.providerId === id) {
          const arr = map.get(link.upstreamModel) ?? [];
          if (!arr.includes(m)) arr.push(m);
          map.set(link.upstreamModel, arr);
        }
    return map;
  }, [models, id]);

  const filtered = useMemo(
    () =>
      (items ?? []).filter((m) =>
        (m.upstreamId + " " + (m.displayName ?? ""))
          .toLowerCase()
          .includes(filter.toLowerCase()),
      ),
    [items, filter],
  );

  const existing = useMemo(
    () => new Set((items ?? []).map((m) => m.upstreamId)),
    [items],
  );

  const toggleSel = (mid: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(mid)) n.delete(mid);
      else n.add(mid);
      return n;
    });

  const allVisibleSelected =
    filtered.length > 0 && filtered.every((m) => selected.has(m.id));

  const quickAdd = async (raw: string) => {
    const ids = raw
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return;
    let added = 0;
    try {
      for (const upstreamId of ids) {
        if (existing.has(upstreamId)) continue;
        await api.createProviderModel(id, { upstreamId });
        added++;
      }
      toast.success(`${plural(added, "model")} added`);
      setAdding(false);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const bulkDelete = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Remove ${plural(selected.size, "imported model")}?`)) return;
    try {
      for (const mid of selected) await api.deleteProviderModel(id, mid);
      toast.success(`${plural(selected.size, "model")} removed`);
      setSelected(new Set());
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <BackLink to={`/providers/${id}/models`} label="Back to provider" />
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
          <>
            <Button variant="outline" onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add upstream model
            </Button>
            <Button onClick={() => setImporting(true)}>
              <Download className="h-3.5 w-3.5" />
              Import from upstream
            </Button>
          </>
        }
      />

      <Card className="gap-0 p-0">
        {/* Bulk actions + search — integrated as the table's own toolbar strip
            rather than a separate floating bar above the card. */}
        <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
          {selected.size > 0 && (
            <Button variant="destructive" size="sm" onClick={bulkDelete}>
              <Trash2 className="h-3.5 w-3.5" />
              Delete {selected.size} selected
            </Button>
          )}
          <TableSearch
            value={filter}
            onChange={setFilter}
            placeholder="Search upstream ID or name…"
            count={filtered.length}
            total={items?.length}
            className="ml-auto"
          />
        </div>
        {!items ? (
          <TableSkeleton
            cols={8}
            widths={["10%", "60%", "50%", "25%", "25%", "25%", "20%", "40%"]}
          />
        ) : items.length === 0 ? (
          <EmptyState msg="No imported models yet — add one above or import from upstream" />
        ) : filtered.length === 0 ? (
          <EmptyState msg="No imported models match the search" />
        ) : (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    aria-label="Select all"
                    checked={allVisibleSelected}
                    onCheckedChange={(checked) =>
                      setSelected(
                        checked
                          ? new Set(filtered.map((m) => m.id))
                          : new Set(),
                      )
                    }
                  />
                </TableHead>
                <TableHead className="w-[24%]">Upstream ID</TableHead>
                <TableHead className="w-[20%]">Display name</TableHead>
                <TableHead className="w-24 text-right">Context</TableHead>
                <TableHead className="w-24 text-right">Max out</TableHead>
                <TableHead
                  className="w-28 text-right"
                  title="This model's own custom transforms. Provider defaults (e.g. prompt caching) always apply on top and aren't counted here — expand a row to see them."
                >
                  Custom
                </TableHead>
                <TableHead>Used by</TableHead>
                <TableHead className="w-24 text-center">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((m) => (
                <ModelRow
                  key={m.id}
                  providerId={id}
                  model={m}
                  usedBy={usedBy.get(m.upstreamId) ?? []}
                  selected={selected.has(m.id)}
                  onToggleSel={() => toggleSel(m.id)}
                  onChanged={load}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {adding && (
        <AddModelDialog onAdd={quickAdd} onClose={() => setAdding(false)} />
      )}

      {importing && provider && (
        <ImportSheet
          provider={provider}
          existing={existing}
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
