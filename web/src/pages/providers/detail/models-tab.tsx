// Models tab: link to the Imported Models manager + the exposed-model table
// this provider is routed through.

import { useState } from "react";
import { Download, Pencil, Loader2, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Model, Provider } from "@/lib/types";
import { EmptyState } from "@/components/shared";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { DefaultTransformsPanel } from "@/components/default-transforms";
import { formatLabel } from "@/lib/utils";

export function ModelsTab({
  provider,
  models,
}: {
  provider: Provider;
  models: Model[];
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-lg border border-border bg-muted/20 p-3">
        <div>
          <div className="text-sm font-medium text-foreground">
            Imported models
          </div>
          <div className="text-[0.7rem] text-muted-foreground">
            The upstream models available to reference in a chain (not exposed).
          </div>
        </div>
        <Link
          to={`/providers/${provider.id}/imported`}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          <Download className="h-3.5 w-3.5" />
          Manage imports
        </Link>
      </div>

      <DefaultTransformsPanel providerId={provider.id} />

      <div>
        <span className="mb-2 block text-xs text-muted-foreground">
          Exposed models with this provider in their fallback chain
        </span>
        {models.length === 0 ? (
          <EmptyState msg="No exposed models route through this provider yet" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Alias</TableHead>
                <TableHead>Upstream model</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Edit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((m) => {
                const link = m.providers.find(
                  (l) => l.providerId === provider.id,
                );
                return (
                  <TableRow key={m.id}>
                    <TableCell className="max-w-[14rem] truncate font-medium">
                      {m.alias}
                    </TableCell>
                    <TableCell className="max-w-[14rem] truncate font-mono text-muted-foreground">
                      {link?.upstreamModel ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{formatLabel(m.type)}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Link
                        to={`/models/${m.id}`}
                        title="Edit model"
                        className={buttonVariants({
                          variant: "ghost",
                          size: "icon",
                        })}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

// --- Danger zone ------------------------------------------------------------
export function DangerZone({
  provider,
  onDeleted,
}: {
  provider: Provider;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const del = async () => {
    if (
      !confirm(
        `Delete provider '${provider.name}'? Models using it will lose this route.`,
      )
    )
      return;
    setDeleting(true);
    try {
      await api.deleteProvider(provider.id);
      toast.success("Provider deleted");
      onDeleted();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };
  return (
    <section className="mt-6 max-w-3xl space-y-1">
      <div className="pb-1">
        <h3 className="text-sm font-semibold text-destructive">Danger zone</h3>
        <p className="text-xs text-muted-foreground">
          Irreversible actions that affect this provider and every model routed
          through it.
        </p>
      </div>
      <div className="rounded-lg border border-destructive/40 bg-destructive/5">
        <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <div className="min-w-0 sm:max-w-[60%]">
            <div className="text-sm font-medium text-foreground">
              Delete provider
            </div>
            <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
              Permanently removes '{provider.name}' and its route from every
              model that references it. This cannot be undone.
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={del}
            disabled={deleting}
            className="shrink-0"
          >
            {deleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            Delete provider
          </Button>
        </div>
      </div>
    </section>
  );
}
