import { memo, useEffect, useMemo, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type { Model } from "@/lib/types";
import {
  PageHeader,
  TableSkeleton,
  EmptyState,
  Pagination,
  TableSearch,
} from "@/components/shared";
import { fmtTokens } from "@/lib/utils";
import { ModelIcon } from "@/components/model-icon";
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
import { Switch } from "@/components/ui/switch";
import { endpointShort } from "./models/shared";

const PAGE_SIZE = 15;

export default function Models() {
  const navigate = useNavigate();
  const [items, setItems] = useState<Model[] | null>(null);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState("");

  const load = useCallback(
    () => api.listModels().then(setItems).catch(toast.error),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  // Reset to the first page whenever the search narrows/widens the result set,
  // so a filtered-out page never shows an empty page 3 of 1.
  useEffect(() => {
    setPage(0);
  }, [filter]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items ?? [];
    return (items ?? []).filter(
      (m) =>
        m.alias.toLowerCase().includes(q) ||
        (m.displayName ?? "").toLowerCase().includes(q),
    );
  }, [items, filter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      <PageHeader
        title="Exposed Models"
        desc="Each alias routes through an ordered provider fallback chain"
        meta={<Badge variant="secondary">{items?.length ?? 0} total</Badge>}
        actions={
          <Button onClick={() => navigate("/models/new")}>
            <Plus className="h-3.5 w-3.5" />
            New Model
          </Button>
        }
      />

      <Card className="gap-0 p-0">
        {/* Search integrated as the table's own toolbar strip — same pattern
            as the Imported Models table, so both tables' search reads and
            behaves identically. */}
        <div className="flex items-center border-b border-border px-4 py-2.5">
          <TableSearch
            value={filter}
            onChange={setFilter}
            placeholder="Search alias or display name…"
            count={filtered.length}
            total={items?.length}
            className="ml-auto"
          />
        </div>
        {!items ? (
          <TableSkeleton
            cols={8}
            widths={["55%", "35%", "60%", "30%", "30%", "70%", "20%", "20%"]}
          />
        ) : items.length === 0 ? (
          <EmptyState msg="No models yet — create one to expose it at /v1" />
        ) : filtered.length === 0 ? (
          <EmptyState msg="No models match the search" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Alias</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Display Name</TableHead>
                <TableHead className="text-right">Context</TableHead>
                <TableHead className="text-right">Max Out</TableHead>
                <TableHead>Fallback Chain</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((m) => (
                <ModelRow
                  key={m.id}
                  model={m}
                  onEdit={(mm) => navigate(`/models/${mm.id}`)}
                  onChanged={load}
                />
              ))}
            </TableBody>
          </Table>
        )}
        {items && (
          <Pagination page={page} pageCount={pageCount} onChange={setPage} />
        )}
      </Card>
    </div>
  );
}

const ModelRow = memo(function ModelRow({
  model: m,
  onEdit,
  onChanged,
}: {
  model: Model;
  onEdit: (m: Model) => void;
  onChanged: () => void;
}) {
  const [toggling, setToggling] = useState(false);

  const toggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      await api.updateModel(m.id, { alias: m.alias, enabled });
      toast.success(enabled ? `${m.alias} enabled` : `${m.alias} disabled`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setToggling(false);
    }
  };

  const del = async () => {
    if (
      !confirm(`Delete model '${m.alias}'? Clients requesting it will get 404.`)
    )
      return;
    try {
      await api.deleteModel(m.id);
      toast.success("Model deleted");
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <TableRow>
      <TableCell className="max-w-[18rem] font-mono text-primary">
        <span className="flex items-center gap-2">
          <ModelIcon alias={m.alias} type={m.type} />
          <span className="truncate" title={m.alias}>
            {m.alias}
          </span>
        </span>
      </TableCell>
      <TableCell>
        <Badge variant="secondary">
          {m.type === "anthropic" ? "Anthropic" : "OpenAI"}
        </Badge>
      </TableCell>
      <TableCell className="max-w-[14rem]">
        <span className="block truncate" title={m.displayName ?? undefined}>
          {m.displayName ?? "—"}
        </span>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {m.contextWindow ? fmtTokens(m.contextWindow) : "—"}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {m.maxOutputTokens ? fmtTokens(m.maxOutputTokens) : "—"}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1">
          {m.providers.length === 0 ? (
            <span className="text-xs font-medium normal-case text-amber-500 dark:text-amber-400">
              No Providers
            </span>
          ) : (
            <>
              {m.providers.slice(0, 2).map((p, i) => (
                <span
                  key={p.providerId}
                  className="flex min-w-0 max-w-40 items-center gap-1"
                >
                  {i > 0 && <span className="text-muted-foreground">→</span>}
                  <Badge
                    variant={p.enabled ? "default" : "secondary"}
                    className="min-w-0 truncate"
                    title={p.providerName ?? p.providerId}
                  >
                    <span className="truncate">
                      {p.providerName ?? p.providerId}
                    </span>
                    {p.endpoint && (
                      <span className="ml-1 shrink-0 text-primary/80">
                        {endpointShort(p.endpoint)}
                      </span>
                    )}
                  </Badge>
                </span>
              ))}
              {m.providers.length > 2 && (
                <Badge
                  variant="secondary"
                  title={m.providers
                    .slice(2)
                    .map((p) => p.providerName ?? p.providerId)
                    .join(", ")}
                >
                  +{m.providers.length - 2} more
                </Badge>
              )}
            </>
          )}
        </div>
      </TableCell>
      <TableCell>
        <Switch
          checked={m.enabled}
          disabled={toggling}
          onCheckedChange={toggle}
          title={m.enabled ? "Disable" : "Enable"}
        />
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onEdit(m)}
            title="Edit"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" onClick={del} title="Delete">
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
});
