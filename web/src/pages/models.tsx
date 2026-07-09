import { memo, useEffect, useState, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Plus,
  Pencil,
  Trash2,
  Check,
  X,
  ArrowUp,
  ArrowDown,
  Cpu,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type {
  Model,
  ModelCapabilities,
  ModelInput,
  Provider,
} from "@/lib/types";
import { DEFAULT_CAPABILITIES } from "@/lib/types";
import {
  PageHeader,
  Spinner,
  EmptyState,
  Field,
  Pagination,
} from "@/components/shared";
import { fmtTokens } from "@/lib/utils";
import { ModelIcon } from "@/components/model-icon";
import { Card, CardContent } from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";

interface ChainRow {
  providerId: string;
  upstreamModel: string;
  enabled: boolean;
  endpoint: string;
  /** Per-hop context-window override ("" = inherit imported base). */
  contextWindow: string;
}

const PAGE_SIZE = 15;

export default function Models() {
  const navigate = useNavigate();
  const { id: routeId } = useParams();
  const [items, setItems] = useState<Model[] | null>(null);
  const [editing, setEditing] = useState<Model | null>(null);
  const [creating, setCreating] = useState(false);
  const [page, setPage] = useState(0);

  const load = useCallback(
    () => api.listModels().then(setItems).catch(toast.error),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  // Deep-link: /models/new opens the create dialog; /models/:id opens the editor
  // for that model once the list has loaded.
  const isNew = window.location.pathname.endsWith("/models/new");
  useEffect(() => {
    if (isNew) {
      setCreating(true);
      setEditing(null);
    } else if (routeId && items) {
      const m = items.find((x) => x.id === routeId) ?? null;
      setEditing(m);
      setCreating(false);
    }
  }, [routeId, isNew, items]);

  // Close returns to the list route (so the URL and dialog stay in sync).
  const closeEditor = () => {
    setCreating(false);
    setEditing(null);
    if (routeId || isNew) navigate("/models");
  };

  const pageCount = Math.max(1, Math.ceil((items?.length ?? 0) / PAGE_SIZE));
  const visible = items?.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) ?? [];

  return (
    <div>
      <PageHeader
        title="Exposed Models"
        desc="Each alias routes through an ordered provider fallback chain"
        meta={<Badge variant="secondary">{items?.length ?? 0} total</Badge>}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" />
            New Model
          </Button>
        }
      />

      <Card>
        <CardContent className="p-0">
          {!items ? (
            <Spinner />
          ) : items.length === 0 ? (
            <EmptyState msg="No models yet — create one to expose it at /v1" />
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
                    onEdit={setEditing}
                    onChanged={load}
                  />
                ))}
              </TableBody>
            </Table>
          )}
          {items && (
            <Pagination page={page} pageCount={pageCount} onChange={setPage} />
          )}
        </CardContent>
      </Card>

      {(creating || editing) && (
        <ModelDialog
          model={editing}
          onClose={closeEditor}
          onSaved={() => {
            closeEditor();
            load();
          }}
        />
      )}
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
      <TableCell className="font-mono text-primary">
        <span className="flex items-center gap-2">
          <ModelIcon alias={m.alias} type={m.type} />
          {m.alias}
        </span>
      </TableCell>
      <TableCell>
        <Badge variant="secondary">
          {m.type === "anthropic" ? "Anthropic" : "OpenAI"}
        </Badge>
      </TableCell>
      <TableCell>{m.displayName ?? "—"}</TableCell>
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
                <span key={p.providerId} className="flex items-center gap-1">
                  {i > 0 && <span className="text-muted-foreground">→</span>}
                  <Badge variant={p.enabled ? "default" : "secondary"}>
                    {p.providerName ?? p.providerId}
                    {p.endpoint && (
                      <span className="ml-1 text-primary/80">
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

function ModelDialog({
  model,
  onClose,
  onSaved,
}: {
  model: Model | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [alias, setAlias] = useState(model?.alias ?? "");
  const [displayName, setDisplayName] = useState(model?.displayName ?? "");
  const [contextWindow, setContextWindow] = useState<string>(
    model?.contextWindow?.toString() ?? "",
  );
  const [maxOutputTokens, setMaxOutputTokens] = useState<string>(
    model?.maxOutputTokens?.toString() ?? "",
  );
  const [enabled, setEnabled] = useState(model?.enabled ?? true);
  const [responsesNative, setResponsesNative] = useState(
    model?.responsesNative ?? false,
  );
  const [modelType, setModelType] = useState(model?.type ?? "openai");
  const [caps, setCaps] = useState<ModelCapabilities>(() => ({
    ...DEFAULT_CAPABILITIES,
    ...(model?.capabilities && typeof model.capabilities === "object"
      ? model.capabilities
      : {}),
  }));
  const [chain, setChain] = useState<ChainRow[]>(
    model?.providers.map((p) => ({
      providerId: p.providerId,
      upstreamModel: p.upstreamModel,
      enabled: p.enabled,
      endpoint: p.endpoint ?? "",
      contextWindow: p.contextWindow?.toString() ?? "",
    })) ?? [],
  );
  const [saving, setSaving] = useState(false);
  const [modelOptions, setModelOptions] = useState<Record<number, string[]>>(
    {},
  );
  const [fetchingIdx, setFetchingIdx] = useState<number | null>(null);

  useEffect(() => {
    api.listProviders().then(setProviders).catch(toast.error);
  }, []);

  const enabledProviders = providers.filter((p) => p.enabled);

  const fetchModels = useCallback(
    async (rowIdx: number, providerId: string) => {
      setFetchingIdx(rowIdx);
      try {
        const res = await api.upstreamModels(providerId);
        setModelOptions((prev) => ({ ...prev, [rowIdx]: res.models }));
        if (res.models.length === 0 && res.error) {
          toast.error(res.error);
        } else if (res.models.length > 0) {
          toast.success(`Fetched ${res.models.length} models`);
        }
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : (e as Error).message);
      } finally {
        setFetchingIdx(null);
      }
    },
    [],
  );

  const addChainRow = () => {
    const first = enabledProviders[0];
    if (!first) {
      toast.error("create an enabled provider first");
      return;
    }
    setChain((c) => [
      ...c,
      {
        providerId: first.id,
        upstreamModel: alias || "",
        enabled: true,
        endpoint: first.endpoints?.[0] ?? "",
        contextWindow: "",
      },
    ]);
  };
  const move = (i: number, dir: -1 | 1) =>
    setChain((c) => {
      const j = i + dir;
      if (j < 0 || j >= c.length) return c;
      const next = [...c];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const save = async () => {
    if (!alias.trim()) {
      toast.error("alias is required");
      return;
    }
    setSaving(true);
    const payload: ModelInput = {
      alias: alias.trim(),
      displayName: displayName.trim() || null,
      contextWindow: contextWindow ? Number(contextWindow) : null,
      maxOutputTokens: maxOutputTokens ? Number(maxOutputTokens) : null,
      enabled,
      responsesNative,
      type: modelType,
      capabilities: caps,
      providers: chain.map((r) => ({
        providerId: r.providerId,
        upstreamModel: r.upstreamModel,
        enabled: r.enabled,
        endpoint: r.endpoint || null,
        contextWindow: r.contextWindow ? Number(r.contextWindow) : null,
      })),
    };
    try {
      if (model) await api.updateModel(model.id, payload);
      else await api.createModel(payload);
      toast.success(model ? "Model updated" : "Model created");
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{model ? "Edit Model" : "New Model"}</DialogTitle>
          <DialogDescription>
            Clients request this model by its alias (subject to the
            prefix/expose settings). The fallback chain is tried top-to-bottom.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Alias" hint="the id clients send, e.g. claude-opus-4-8">
            <Input value={alias} onChange={(e) => setAlias(e.target.value)} />
          </Field>
          <Field label="Display name">
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </Field>
          <Field label="Context window (tokens)">
            <Input
              type="number"
              value={contextWindow}
              onChange={(e) => setContextWindow(e.target.value)}
            />
          </Field>
          <Field label="Max output tokens">
            <Input
              type="number"
              value={maxOutputTokens}
              onChange={(e) => setMaxOutputTokens(e.target.value)}
            />
          </Field>
          <Field label="Type">
            <Select value={modelType} onValueChange={setModelType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI</SelectItem>
                <SelectItem value="anthropic">Anthropic</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>

        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} />
            <span className="text-xs font-medium text-muted-foreground normal-case">
              Enabled
            </span>
          </label>
          {modelType === "openai" && (
            <label className="flex items-center gap-2">
              <Switch
                checked={responsesNative}
                onCheckedChange={setResponsesNative}
              />
              <span className="text-xs font-medium text-muted-foreground normal-case">
                Native /v1/responses
              </span>
            </label>
          )}
        </div>

        <CapabilitiesEditor
          caps={caps}
          onChange={setCaps}
          locked={model?.capabilitiesLocked ?? false}
        />

        <div className="mt-2">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cpu className="h-3.5 w-3.5 text-primary" />
              <span className="text-sm font-medium text-foreground">
                Fallback chain
              </span>
              <span className="text-xs text-muted-foreground">
                tried in order
              </span>
            </div>
            <Button variant="outline" size="sm" onClick={addChainRow}>
              <Plus className="h-3.5 w-3.5" />
              Add Provider
            </Button>
          </div>

          {chain.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
              No providers in chain — add one so requests can route
            </div>
          ) : (
            <div className="space-y-3">
              {chain.map((row, i) => {
                const provider = providers.find((p) => p.id === row.providerId);
                const allEndpoints = provider?.endpoints?.length
                  ? provider.endpoints
                  : ["/v1/messages", "/v1/chat/completions", "/v1/responses"];
                const allowed =
                  modelType === "anthropic"
                    ? ["/v1/messages"]
                    : ["/v1/chat/completions", "/v1/responses"];
                const supported = allEndpoints.filter((ep) =>
                  allowed.includes(ep),
                );
                const endpointOptions = Array.from(
                  new Set([row.endpoint, ...supported]),
                ).filter(Boolean);
                return (
                  <div
                    key={i}
                    className="rounded-lg border border-border bg-card p-4 overflow-hidden"
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[0.65rem] font-bold text-primary">
                          {i + 1}
                        </span>
                        <span className="text-sm font-medium text-foreground">
                          {provider?.name ?? "Select provider"}
                        </span>
                        {provider && (
                          <HopConversionBadge
                            provider={provider}
                            modelType={modelType}
                          />
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          title={row.enabled ? "Disable" : "Enable"}
                          className={`flex h-6 w-6 items-center justify-center rounded-md cursor-pointer transition-colors ${
                            row.enabled
                              ? "bg-primary/80 text-primary-foreground hover:bg-primary/60"
                              : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                          }`}
                          onClick={() =>
                            setChain((c) =>
                              c.map((r, j) =>
                                j === i ? { ...r, enabled: !r.enabled } : r,
                              ),
                            )
                          }
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
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
                          disabled={i === chain.length - 1}
                        >
                          <ArrowDown className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() =>
                            setChain((c) => c.filter((_, j) => j !== i))
                          }
                        >
                          <Trash2 className="h-3 w-3 text-destructive" />
                        </Button>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <Field label="Provider">
                        <div className="relative">
                          <Select
                            value={row.providerId}
                            onValueChange={(v) => {
                              const p = providers.find((x) => x.id === v);
                              const ep = p?.endpoints ?? [];
                              const endpoint =
                                ep.length && !ep.includes(row.endpoint)
                                  ? ep[0]
                                  : row.endpoint;
                              setChain((c) =>
                                c.map((r, j) =>
                                  j === i
                                    ? { ...r, providerId: v, endpoint }
                                    : r,
                                ),
                              );
                              setModelOptions((prev) => {
                                const next = { ...prev };
                                delete next[i];
                                return next;
                              });
                            }}
                          >
                            <SelectTrigger className="justify-start gap-2 pr-8 [&>svg:last-child]:hidden">
                              <SelectValue placeholder="Select provider" />
                            </SelectTrigger>
                            <SelectContent>
                              {enabledProviders.map((p) => (
                                <SelectItem key={p.id} value={p.id}>
                                  {p.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <button
                            type="button"
                            title="Fetch upstream models"
                            disabled={fetchingIdx === i || !row.providerId}
                            onClick={() => fetchModels(i, row.providerId)}
                            className="absolute right-1 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <RefreshCw
                              className={`h-3 w-3 ${fetchingIdx === i ? "animate-spin" : ""}`}
                            />
                          </button>
                        </div>
                      </Field>
                      <Field label="Upstream model">
                        <Combobox
                          value={row.upstreamModel}
                          onChange={(v) =>
                            setChain((c) =>
                              c.map((r, j) =>
                                j === i ? { ...r, upstreamModel: v } : r,
                              ),
                            )
                          }
                          options={modelOptions[i] ?? []}
                          placeholder="e.g. gpt-4o"
                          searchPlaceholder="Filter models…"
                          allowCustom
                          mono
                        />
                      </Field>
                      <Field label="Endpoint">
                        <Select
                          value={row.endpoint || supported[0] || ""}
                          onValueChange={(ep) =>
                            setChain((c) =>
                              c.map((r, j) =>
                                j === i ? { ...r, endpoint: ep } : r,
                              ),
                            )
                          }
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="endpoint" />
                          </SelectTrigger>
                          <SelectContent>
                            {endpointOptions.map((ep) => (
                              <SelectItem key={ep} value={ep}>
                                {ep}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                    </div>
                    <div className="mt-3">
                      <Field
                        label="Context window override"
                        hint="Optional — if a request would exceed this, the gateway skips this hop and falls back to the next provider. Blank = use the imported model's window."
                      >
                        <Input
                          type="number"
                          value={row.contextWindow}
                          placeholder="inherit"
                          onChange={(e) =>
                            setChain((c) =>
                              c.map((r, j) =>
                                j === i
                                  ? { ...r, contextWindow: e.target.value }
                                  : r,
                              ),
                            )
                          }
                        />
                      </Field>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !alias.trim()}>
            <Check className="h-3.5 w-3.5" />
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Compact capability editor: pill toggles for boolean capabilities plus
// thinking-type and effort-level pickers. Shapes mirror the Anthropic
// /v1/models listing, which is what these values feed. When `locked`, the
// alias matches an official Anthropic model and the server pins capabilities
// to the stock Anthropic entry — shown read-only here.
function CapabilitiesEditor({
  caps,
  onChange,
  locked = false,
}: {
  caps: ModelCapabilities;
  onChange: (c: ModelCapabilities) => void;
  locked?: boolean;
}) {
  const [open, setOpen] = useState(false);

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

  const pill = (on: boolean, label: string, toggle: () => void) => (
    <button
      key={label}
      type="button"
      disabled={locked}
      onClick={toggle}
      className={
        "rounded-md border px-2.5 py-1 text-xs transition-colors " +
        (locked ? "cursor-default " : "cursor-pointer ") +
        (on
          ? "border-primary bg-primary/10 text-primary"
          : locked
            ? "border-border text-muted-foreground/50"
            : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground")
      }
    >
      {label}
    </button>
  );

  const summary = [
    ...FLAGS.filter((f) => flagOn(f.key)).map((f) => f.label),
    caps.thinking.supported ? "Thinking" : null,
    caps.effort.supported ? "Effort" : null,
  ].filter(Boolean);

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center justify-between gap-3"
        onClick={() => setOpen((o) => !o)}
      >
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
          {open ? "collapse" : summary.length ? summary.join(" · ") : "none"}
        </span>
      </button>

      {open && (
        <div className="mt-3 space-y-4">
          {locked && (
            <p className="text-[0.65rem] text-muted-foreground">
              This alias matches an official Anthropic model, so its thinking
              types, effort levels and other capabilities are pinned to the
              Anthropic API's own metadata and can't be overridden.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {FLAGS.map((f) =>
              pill(flagOn(f.key), f.label, () =>
                setFlag(f.key, !flagOn(f.key)),
              ),
            )}
          </div>

          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <Switch
                checked={caps.thinking.supported}
                disabled={locked}
                onCheckedChange={(v) =>
                  onChange({
                    ...caps,
                    thinking: { ...caps.thinking, supported: v },
                  })
                }
              />
              <span className="text-xs font-medium text-foreground">
                Thinking
              </span>
            </div>
            {caps.thinking.supported && (
              <div className="flex gap-2 pl-8">
                {(["adaptive", "enabled"] as const).map((t) =>
                  pill(caps.thinking.types[t].supported, t, () =>
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
                  ),
                )}
              </div>
            )}
          </div>

          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <Switch
                checked={caps.effort.supported}
                disabled={locked}
                onCheckedChange={(v) =>
                  onChange({
                    ...caps,
                    effort: { ...caps.effort, supported: v },
                  })
                }
              />
              <span className="text-xs font-medium text-foreground">
                Effort levels
              </span>
            </div>
            {caps.effort.supported && (
              <div className="flex gap-2 pl-8">
                {EFFORTS.map((e) =>
                  pill(caps.effort[e].supported, e, () =>
                    onChange({
                      ...caps,
                      effort: {
                        ...caps.effort,
                        [e]: { supported: !caps.effort[e].supported },
                      },
                    }),
                  ),
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function endpointShort(ep: string): string {
  if (ep.endsWith("/messages")) return "msg";
  if (ep.endsWith("/responses")) return "resp";
  if (ep.endsWith("/chat/completions")) return "chat";
  return ep;
}

// Per-hop conversion indicator for the chain editor. Tells the user, for this
// exposed model's wire format, whether the gateway will translate the request
// to reach this provider or send it through untouched.
//   - provider.nativeConversion  -> provider converts internally (no gateway xform)
//   - provider.format === client -> same format, no conversion
//   - otherwise                  -> gateway converts client <-> provider format
function HopConversionBadge({
  provider,
  modelType,
}: {
  provider: Provider;
  modelType: string;
}) {
  // The exposed model's wire format is the client side of this hop. An
  // anthropic-typed alias speaks messages; everything else speaks chat.
  const clientFmt = modelType === "anthropic" ? "anthropic" : "openai";
  if (provider.nativeConversion) {
    return (
      <Badge
        variant="default"
        title="Provider accepts the request as-is and converts internally — the gateway forwards it unchanged."
      >
        provider converts
      </Badge>
    );
  }
  const converts = provider.format !== clientFmt;
  return (
    <Badge
      variant={converts ? "warning" : "secondary"}
      title={
        converts
          ? `Gateway converts ${clientFmt} → ${provider.format} for this hop.`
          : "Same wire format — no conversion for this hop."
      }
    >
      {converts ? "gateway converts" : "no conversion"}
    </Badge>
  );
}

