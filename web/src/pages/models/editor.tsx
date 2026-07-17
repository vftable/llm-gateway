// Model editor — a routed page (/models/new, /models/:id).
//
// The fallback chain is too large for a modal, so the editor is a full page with
// section tabs (Basics · Capabilities · Chain). Per-model request/response
// transforms live on the imported provider-models (their own editor on the
// provider's Imported Models page), so they aren't edited here.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Plus,
  Check,
  X,
  GripVertical,
  Trash2,
  RefreshCw,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type {
  HopStat,
  Model,
  ModelCapabilities,
  ModelInput,
  Provider,
  ProviderModel,
} from "@/lib/types";
import { DEFAULT_CAPABILITIES } from "@/lib/types";
import {
  PageHeader,
  PageSkeleton,
  Field,
  BackLink,
  SectionTabs,
} from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { ModelIcon } from "@/components/model-icon";
import {
  type ChainRow,
  HopConversionBadge,
  CapabilitiesEditor,
} from "./shared";
import { cn, fmtNum } from "@/lib/utils";
import { useVerticalReorder } from "@/hooks/use-vertical-reorder";

type TabId = "basics" | "capabilities" | "chain";
const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "basics", label: "Basics" },
  { id: "capabilities", label: "Capabilities" },
  { id: "chain", label: "Chain" },
];

export default function ModelEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id;

  const [loaded, setLoaded] = useState(isNew);
  const [model, setModel] = useState<Model | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [tab, setTab] = useState<TabId>("basics");

  // form state
  const [alias, setAlias] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [responsesNative, setResponsesNative] = useState(false);
  const [modelType, setModelType] = useState("openai");
  const [caps, setCaps] = useState<ModelCapabilities>(DEFAULT_CAPABILITIES);
  const [chain, setChain] = useState<ChainRow[]>([]);
  const [saving, setSaving] = useState(false);
  // Extra upstream ids discovered via the per-row "fetch" button, keyed by row.
  const [fetchedOptions, setFetchedOptions] = useState<
    Record<number, string[]>
  >({});
  const [fetchingIdx, setFetchingIdx] = useState<number | null>(null);
  // The provider's imported-model catalog, cached per provider id. This is the
  // curated source a chain references — offered first in the upstream picker.
  const [catalog, setCatalog] = useState<Record<string, ProviderModel[]>>({});
  const [catalogLoading, setCatalogLoading] = useState<Set<string>>(new Set());
  // Per-hop success/error hit counts, keyed by "providerId:upstreamModel".
  const [hopStats, setHopStats] = useState<Record<string, HopStat>>({});

  // Hydrate the form from a model (edit) or defaults (new).
  const hydrate = useCallback((m: Model | null) => {
    setModel(m);
    setAlias(m?.alias ?? "");
    setDisplayName(m?.displayName ?? "");
    setContextWindow(m?.contextWindow?.toString() ?? "");
    setMaxOutputTokens(m?.maxOutputTokens?.toString() ?? "");
    setEnabled(m?.enabled ?? true);
    setResponsesNative(m?.responsesNative ?? false);
    setModelType(m?.type ?? "openai");
    setCaps({
      ...DEFAULT_CAPABILITIES,
      ...(m?.capabilities && typeof m.capabilities === "object"
        ? m.capabilities
        : {}),
    });
    setChain(
      m?.providers.map((p) => ({
        providerId: p.providerId,
        upstreamModel: p.upstreamModel,
        enabled: p.enabled,
        endpoint: p.endpoint ?? null,
      })) ?? [],
    );
  }, []);

  useEffect(() => {
    api.listProviders().then(setProviders).catch(toast.error);
  }, []);

  useEffect(() => {
    if (isNew) {
      hydrate(null);
      setLoaded(true);
      return;
    }
    let live = true;
    api
      .listModels()
      .then((ms) => {
        if (!live) return;
        const m = ms.find((x) => x.id === id) ?? null;
        hydrate(m);
        setLoaded(true);
      })
      .catch((e) => {
        toast.error((e as Error).message);
        setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [id, isNew, hydrate]);

  // Per-hop hit counts for the Chain tab — best-effort, doesn't block the form.
  useEffect(() => {
    if (isNew || !id) return;
    api
      .hopStats(id)
      .then((stats) =>
        setHopStats(
          Object.fromEntries(
            stats.map((s) => [`${s.providerId}:${s.upstreamModel}`, s]),
          ),
        ),
      )
      .catch(() => {});
  }, [id, isNew]);

  const enabledProviders = useMemo(
    () => providers.filter((p) => p.enabled),
    [providers],
  );

  // Load a provider's imported-model catalog once (cached). Called when a chain
  // row targets a provider we haven't fetched yet.
  const loadCatalog = useCallback(
    (providerId: string) => {
      if (!providerId || catalog[providerId] || catalogLoading.has(providerId))
        return;
      setCatalogLoading((s) => new Set(s).add(providerId));
      api
        .listProviderModels(providerId)
        .then((pms) => setCatalog((c) => ({ ...c, [providerId]: pms })))
        .catch(() => {})
        .finally(() =>
          setCatalogLoading((s) => {
            const n = new Set(s);
            n.delete(providerId);
            return n;
          }),
        );
    },
    [catalog, catalogLoading],
  );

  // Whenever the chain's set of providers changes, ensure each has its catalog.
  useEffect(() => {
    for (const row of chain) if (row.providerId) loadCatalog(row.providerId);
  }, [chain, loadCatalog]);

  // The upstream-id options for a chain row: the provider's imported catalog
  // (curated, primary) unioned with anything discovered via the fetch button.
  const optionsForRow = useCallback(
    (rowIdx: number, providerId: string): string[] => {
      const imported = (catalog[providerId] ?? []).map((m) => m.upstreamId);
      const fetched = fetchedOptions[rowIdx] ?? [];
      return Array.from(new Set([...imported, ...fetched]));
    },
    [catalog, fetchedOptions],
  );

  // Display-name descriptions for the combobox, from the imported catalog.
  const descriptionsForProvider = useCallback(
    (providerId: string): Record<string, string | undefined> => {
      const out: Record<string, string | undefined> = {};
      for (const m of catalog[providerId] ?? [])
        if (m.displayName) out[m.upstreamId] = m.displayName;
      return out;
    },
    [catalog],
  );

  const fetchModels = useCallback(
    async (rowIdx: number, providerId: string) => {
      setFetchingIdx(rowIdx);
      try {
        const res = await api.upstreamModels(providerId);
        // The chain-editor datalist only needs ids; the universal list carries
        // more, but here we just surface pickable upstream ids.
        const ids = res.models.map((m) => m.id);
        setFetchedOptions((prev) => ({ ...prev, [rowIdx]: ids }));
        if (ids.length === 0 && res.error) toast.error(res.error);
        else if (ids.length > 0) toast.success(`Fetched ${ids.length} models`);
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
        endpoint: null,
      },
    ]);
  };
  // Drag-to-reorder: pulls the dragged row out and re-inserts it at the drop
  // index, shifting everything between.
  const reorder = (from: number, to: number) =>
    setChain((c) => {
      if (from === to || from < 0 || to < 0 || from >= c.length) return c;
      const next = [...c];
      const [row] = next.splice(from, 1);
      next.splice(to, 0, row);
      return next;
    });
  // Pointer-based, Y-only drag (see hook doc) — the row can't drift
  // horizontally, and `overIndex` drives a highlighted drop-target slot
  // instead of just dimming the row being dragged.
  const { dragIndex, overIndex, registerRow, handleProps, rowStyle } =
    useVerticalReorder(chain.length, reorder);

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
      })),
    };
    try {
      if (model) await api.updateModel(model.id, payload);
      else await api.createModel(payload);
      toast.success(model ? "Model updated" : "Model created");
      navigate("/models");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!loaded)
    return (
      <div className="space-y-4">
        <BackLink to="/models" label="Back to Models" />
        <PageSkeleton tabs={TABS.length} />
      </div>
    );

  return (
    <div className="space-y-4 pb-24">
      <BackLink to="/models" label="Back to Models" />
      <PageHeader
        title={
          model ? (
            <span className="inline-flex items-center gap-2.5 text-primary">
              <ModelIcon alias={alias} type={modelType} className="size-5" />
              Edit {model.alias}
            </span>
          ) : (
            "New Model"
          )
        }
        desc="Clients request this model by its alias; the fallback chain is tried top-to-bottom."
        actions={
          <div className="flex gap-3">
            <Button variant="outline" onClick={() => navigate("/models")}>
              <X className="h-3.5 w-3.5" />
              Cancel
            </Button>
            <Button onClick={save} disabled={saving || !alias.trim()}>
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        }
      />

      <SectionTabs
        sections={TABS.map((t) =>
          t.id === "chain"
            ? {
                ...t,
                badge: (
                  <span className="text-xs text-muted-foreground">
                    ({chain.length})
                  </span>
                ),
              }
            : t,
        )}
        active={tab}
        onChange={setTab}
      />

      {tab === "basics" && (
        <div className="max-w-4xl space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field
              label="Alias"
              hint="the ID clients send, e.g. claude-opus-4-8"
            >
              <Input value={alias} onChange={(e) => setAlias(e.target.value)} />
            </Field>
            <Field label="Display name">
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </Field>
            <Field label="Active">
              <label className="flex h-9 cursor-pointer items-center gap-2">
                <Switch checked={enabled} onCheckedChange={setEnabled} />
                <span
                  className={cn(
                    "text-xs font-medium",
                    enabled ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {enabled ? "Enabled" : "Disabled"}
                </span>
              </label>
              <p className="text-[0.65rem] text-muted-foreground">
                Disabled models are skipped by every request.
              </p>
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
          </div>
          {modelType === "openai" && (
            <label className="flex items-center gap-2">
              <Switch
                checked={responsesNative}
                onCheckedChange={setResponsesNative}
              />
              <span className="text-xs font-medium normal-case text-muted-foreground">
                Native <span className="font-mono">/v1/responses</span>
              </span>
            </label>
          )}
        </div>
      )}

      {tab === "capabilities" && (
        <CapabilitiesEditor
          caps={caps}
          onChange={setCaps}
          locked={model?.capabilitiesLocked ?? false}
        />
      )}

      {tab === "chain" && (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              Providers are tried in order; a hop is skipped on failure or when
              a request exceeds its context window.
            </span>
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
            <div className="no-scrollbar overflow-x-auto rounded-lg border border-border">
              <div className="grid min-w-220 grid-cols-[2.75rem_11rem_minmax(10rem,1fr)_6.5rem_10rem_3rem_3.5rem_3.5rem_3.25rem] items-center gap-3 border-b border-border bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
                <span>Hop</span>
                <span>Provider</span>
                <span>Upstream model</span>
                <span>Endpoint</span>
                <span className="pl-3">Conversion</span>
                <span>Active</span>
                <span className="text-right" title="Successful hits (2xx)">
                  Success
                </span>
                <span
                  className="text-right"
                  title="Failed hits — non-2xx status, including timeouts and bad requests"
                >
                  Errors
                </span>
                <span className="text-right">Actions</span>
              </div>
              <div className="divide-y divide-border">
                {chain.map((row, i) => {
                  const provider = providers.find(
                    (p) => p.id === row.providerId,
                  );
                  const dragging = i === dragIndex;
                  const dropTarget =
                    dragIndex !== null && i === overIndex && i !== dragIndex;
                  return (
                    <div
                      key={i}
                      ref={registerRow(i)}
                      style={rowStyle(i)}
                      className={cn(
                        "relative grid min-w-220 grid-cols-[2.75rem_11rem_minmax(10rem,1fr)_6.5rem_10rem_3rem_3.5rem_3.5rem_3.25rem] items-center gap-3 bg-card px-3 py-2.5 text-sm",
                        dragging
                          ? // Floats above the list, locked to vertical motion
                            // only (rowStyle only ever sets translateY) —
                            // elevated + slightly rounded so it visibly
                            // detaches from the flat row list beneath it.
                            "z-10 scale-[1.01] rounded-md shadow-lg ring-1 ring-border"
                          : "transition-colors hover:bg-muted/20",
                        dropTarget &&
                          // The slot the dragged row will land in on release.
                          "bg-primary/5 ring-1 ring-inset ring-primary/40",
                      )}
                    >
                      <div className="flex h-8 items-center gap-1">
                        <span
                          {...handleProps(i)}
                          className="flex h-6 w-4 cursor-grab items-center justify-center text-muted-foreground hover:text-foreground active:cursor-grabbing"
                          title="Drag to reorder"
                        >
                          <GripVertical className="h-3.5 w-3.5" />
                        </span>
                        <span className="font-mono text-muted-foreground">
                          #{i + 1}
                        </span>
                      </div>
                      <div className="relative">
                        <Select
                          value={row.providerId}
                          onValueChange={(v) => {
                            setChain((c) =>
                              c.map((r, j) =>
                                j === i ? { ...r, providerId: v } : r,
                              ),
                            );
                            // Drop this row's fetched-id cache (provider changed);
                            // the new provider's catalog loads via the effect.
                            setFetchedOptions((prev) => {
                              const next = { ...prev };
                              delete next[i];
                              return next;
                            });
                            loadCatalog(v);
                          }}
                        >
                          <SelectTrigger
                            className="h-8 justify-start gap-2 pr-8 text-xs [&>svg:last-child]:hidden"
                            aria-label="Provider"
                          >
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
                        <Button
                          type="button"
                          variant="soft"
                          size="icon-xs"
                          title="Fetch upstream models"
                          disabled={fetchingIdx === i || !row.providerId}
                          onClick={() => fetchModels(i, row.providerId)}
                          className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
                        >
                          <RefreshCw
                            className={`h-3 w-3 ${fetchingIdx === i ? "animate-spin" : ""}`}
                          />
                        </Button>
                      </div>
                      <div
                        className="min-w-0"
                        title={
                          row.upstreamModel &&
                          row.providerId &&
                          catalog[row.providerId] &&
                          !(catalog[row.providerId] ?? []).some(
                            (m) => m.upstreamId === row.upstreamModel,
                          )
                            ? "New ID — imported into this provider's catalog on save."
                            : undefined
                        }
                      >
                        <Combobox
                          value={row.upstreamModel}
                          onChange={(v) =>
                            setChain((c) =>
                              c.map((r, j) =>
                                j === i ? { ...r, upstreamModel: v } : r,
                              ),
                            )
                          }
                          options={optionsForRow(i, row.providerId)}
                          descriptions={descriptionsForProvider(row.providerId)}
                          placeholder={
                            catalogLoading.has(row.providerId)
                              ? "Loading catalog…"
                              : "Pick or type an ID"
                          }
                          searchPlaceholder="Filter imported models…"
                          emptyText="No imported models — type an ID or fetch from upstream"
                          allowCustom
                          mono
                          className="h-8 text-xs"
                        />
                      </div>
                      <div>
                        <Select
                          value={row.endpoint ?? "auto"}
                          onValueChange={(v) =>
                            setChain((c) =>
                              c.map((r, j) =>
                                j === i
                                  ? {
                                      ...r,
                                      endpoint: v === "auto" ? null : v,
                                    }
                                  : r,
                              ),
                            )
                          }
                        >
                          <SelectTrigger
                            className="h-8 text-xs"
                            aria-label="Endpoint"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">Auto</SelectItem>
                            {(provider?.endpoints ?? ["chat"]).map((ep) => (
                              <SelectItem key={ep} value={ep}>
                                {ep === "chat"
                                  ? "Chat"
                                  : ep === "messages"
                                    ? "Messages"
                                    : "Responses"}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex h-8 min-w-0 items-center pl-3">
                        {provider && (
                          <HopConversionBadge
                            provider={provider}
                            modelType={modelType}
                            endpoint={row.endpoint}
                          />
                        )}
                      </div>
                      <div className="flex h-8 items-center">
                        <Switch
                          checked={row.enabled}
                          onCheckedChange={(v) =>
                            setChain((c) =>
                              c.map((r, j) =>
                                j === i ? { ...r, enabled: v } : r,
                              ),
                            )
                          }
                          title={row.enabled ? "Disable hop" : "Enable hop"}
                        />
                      </div>
                      {(() => {
                        const stat =
                          hopStats[`${row.providerId}:${row.upstreamModel}`];
                        return (
                          <>
                            <div
                              className="flex h-8 items-center justify-end font-mono text-success"
                              title={`${fmtNum(stat?.success ?? 0)} successful hits (2xx)`}
                            >
                              {fmtNum(stat?.success ?? 0)}
                            </div>
                            <div
                              className={cn(
                                "flex h-8 items-center justify-end font-mono",
                                stat && stat.errors > 0
                                  ? "text-destructive"
                                  : "text-muted-foreground",
                              )}
                              title={`${fmtNum(stat?.errors ?? 0)} failed hits — non-2xx status, including timeouts and bad requests`}
                            >
                              {fmtNum(stat?.errors ?? 0)}
                            </div>
                          </>
                        );
                      })()}
                      <div className="flex h-8 items-center justify-end">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() =>
                            setChain((c) => c.filter((_, j) => j !== i))
                          }
                          title="Remove hop"
                          aria-label="Remove hop"
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
