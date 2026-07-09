// Per-model transform editor. Pick transforms from the library (GET
// /api/transforms), configure their params from the declared spec, order them,
// and remove them. Emits ModelTransformConfig[]. Used by the imported-model
// editor. Purely controlled — the parent owns the value.

import { useEffect, useState } from "react";
import { Plus, Trash2, ArrowUp, ArrowDown } from "lucide-react";
import { api } from "@/lib/api";
import type {
  ModelTransformConfig,
  TransformDefInfo,
  TransformPhase,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export function TransformEditor({
  value,
  onChange,
}: {
  value: ModelTransformConfig[];
  onChange: (v: ModelTransformConfig[]) => void;
}) {
  const [lib, setLib] = useState<TransformDefInfo[]>([]);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api
      .listTransforms()
      .then(setLib)
      .catch(() => {});
  }, []);

  const defOf = (id: string) => lib.find((d) => d.id === id);

  const add = (id: string) => {
    const def = defOf(id);
    if (!def) return;
    onChange([
      ...value,
      { id, phase: def.phases[0] ?? "request", params: {} },
    ]);
    setAdding(false);
  };

  const patch = (i: number, next: Partial<ModelTransformConfig>) =>
    onChange(value.map((t, j) => (j === i ? { ...t, ...next } : t)));

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {value.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No transforms. Add one to rewrite the request or response body for this
          model.
        </p>
      )}

      {value.map((t, i) => {
        const def = defOf(t.id);
        return (
          <div
            key={i}
            className="rounded-lg border border-border bg-card p-3 space-y-2"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">
                  {def?.label ?? t.id}
                </span>
                <PhasePicker
                  phases={def?.phases ?? ["request", "response"]}
                  value={t.phase}
                  onChange={(phase) => patch(i, { phase })}
                />
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                >
                  <ArrowUp className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => move(i, 1)}
                  disabled={i === value.length - 1}
                >
                  <ArrowDown className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onChange(value.filter((_, j) => j !== i))}
                >
                  <Trash2 className="h-3 w-3 text-destructive" />
                </Button>
              </div>
            </div>
            {def?.blurb && (
              <p className="text-[0.65rem] text-muted-foreground">{def.blurb}</p>
            )}
            {def && def.params.length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                {def.params.map((p) => (
                  <label key={p.key} className="block">
                    <span className="mb-1 block text-[0.65rem] font-medium text-muted-foreground">
                      {p.label}
                      {p.required && <span className="text-destructive"> *</span>}
                    </span>
                    <Input
                      value={String(t.params[p.key] ?? "")}
                      placeholder={p.placeholder}
                      type={p.type === "number" ? "number" : "text"}
                      onChange={(e) =>
                        patch(i, {
                          params: {
                            ...t.params,
                            [p.key]:
                              p.type === "number"
                                ? e.target.value === ""
                                  ? undefined
                                  : Number(e.target.value)
                                : e.target.value,
                          },
                        })
                      }
                      className="font-mono"
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {adding ? (
        <div className="rounded-lg border border-dashed border-border p-2">
          <Select value="" onValueChange={add}>
            <SelectTrigger>
              <SelectValue placeholder="Pick a transform…" />
            </SelectTrigger>
            <SelectContent>
              {lib.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.label} — {d.blurb}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" />
          Add transform
        </Button>
      )}
    </div>
  );
}

// Small request/response toggle, limited to the phases the transform supports.
function PhasePicker({
  phases,
  value,
  onChange,
}: {
  phases: TransformPhase[];
  value: TransformPhase;
  onChange: (p: TransformPhase) => void;
}) {
  if (phases.length < 2) {
    return (
      <Badge variant="secondary" className="capitalize">
        {value}
      </Badge>
    );
  }
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-border">
      {phases.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={cn(
            "cursor-pointer px-2 py-0.5 text-[0.65rem] font-medium capitalize transition-colors",
            value === p
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {p}
        </button>
      ))}
    </div>
  );
}
