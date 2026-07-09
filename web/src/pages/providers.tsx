// Provider-centric browser. Providers are shown as a responsive card grid;
// clicking a card opens a tabbed detail dialog (Overview / Config / Models /
// Advanced). New providers are added through the stepped Add-Provider wizard
// (./providers/add-provider-dialog), which pre-fills config from the catalog.

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  Zap,
  Check,
  X,
  Loader2,
  Download,
  ExternalLink,
  Boxes,
  KeyRound,
  Cpu,
} from "lucide-react";
import { toast } from "sonner";
import { Link } from "react-router-dom";
import { api, ApiError } from "@/lib/api";
import type {
  Model,
  Provider,
  ProviderInput,
  ProviderTestResult,
  ProviderTestInput,
  ProviderFormat,
} from "@/lib/types";
import { PageHeader, Spinner, EmptyState, Field } from "@/components/shared";
import { ProviderIcon } from "@/components/model-icon";
import { CountryFlag, COUNTRIES } from "@/components/country-flag";
import { AddProviderDialog } from "./providers/add-provider-dialog";
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
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn, formatLabel, authSchemeLabel, conversionLabel, conversionHelp, plural } from "@/lib/utils";

const SCHEMES = ["bearer", "xapikey", "both", "passthrough"] as const;

export default function Providers() {
  const [items, setItems] = useState<Provider[] | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [adding, setAdding] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(() => {
    api.listProviders().then(setItems).catch(toast.error);
    api
      .listModels()
      .then(setModels)
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Count of models routed through each provider (for card badges).
  const modelCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const m of models)
      for (const link of m.providers)
        counts[link.providerId] = (counts[link.providerId] ?? 0) + 1;
    return counts;
  }, [models]);

  const detail = items?.find((p) => p.id === detailId) ?? null;

  return (
    <div>
      <PageHeader
        title="Providers"
        desc="Upstream LLM endpoints with retry, key rotation and fallback"
        meta={<Badge variant="secondary">{items?.length ?? 0} total</Badge>}
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" />
            New Provider
          </Button>
        }
      />

      {!items ? (
        <Spinner />
      ) : items.length === 0 ? (
        <SetupCard onStart={() => setAdding(true)} />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              modelCount={modelCounts[p.id] ?? 0}
              onOpen={() => setDetailId(p.id)}
              onChanged={load}
            />
          ))}
        </div>
      )}

      {adding && (
        <AddProviderDialog
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            load();
          }}
        />
      )}

      {detail && (
        <ProviderDetail
          provider={detail}
          models={models.filter((m) =>
            m.providers.some((l) => l.providerId === detail.id),
          )}
          onClose={() => setDetailId(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

// --- First-run setup card ---------------------------------------------------
// Shown when no providers exist yet: a short guided intro that launches the
// stepped Add-Provider wizard (pick from catalog → configure → test → import).
function SetupCard({ onStart }: { onStart: () => void }) {
  const steps = [
    { icon: Boxes, label: "Pick a provider", hint: "OpenAI, Anthropic, Gemini, NIM, a proxy…" },
    { icon: KeyRound, label: "Add your key", hint: "Paste a key; base URL is pre-filled" },
    { icon: Zap, label: "Test the connection", hint: "One click, before you save" },
    { icon: Cpu, label: "Import models", hint: "Pull the upstream model list in" },
  ];
  return (
    <Card className="items-center gap-6 py-10 text-center">
      <div className="space-y-1">
        <h2 className="font-heading text-lg font-semibold text-foreground">
          Set up your first provider
        </h2>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">
          A provider is an upstream LLM endpoint the gateway routes to. The wizard
          walks you through it in four steps.
        </p>
      </div>
      <div className="grid w-full max-w-3xl grid-cols-1 gap-3 sm:grid-cols-4">
        {steps.map((s, i) => (
          <div
            key={s.label}
            className="flex flex-col items-center gap-1.5 rounded-lg border border-border bg-muted/20 p-4"
          >
            <span className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary">
              <s.icon className="h-4 w-4" />
            </span>
            <span className="text-xs font-medium text-foreground">
              {i + 1}. {s.label}
            </span>
            <span className="text-[0.65rem] leading-snug text-muted-foreground">
              {s.hint}
            </span>
          </div>
        ))}
      </div>
      <Button onClick={onStart} size="lg">
        <Plus className="h-4 w-4" />
        Add your first provider
      </Button>
    </Card>
  );
}

// --- Card -------------------------------------------------------------------
const ProviderCard = memo(function ProviderCard({
  provider,
  modelCount,
  onOpen,
  onChanged,
}: {
  provider: Provider;
  modelCount: number;
  onOpen: () => void;
  onChanged: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [result, setResult] = useState<ProviderTestResult | null>(null);

  const toggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      await api.updateProvider(provider.id, {
        name: provider.name,
        baseUrl: provider.baseUrl,
        enabled,
      });
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setToggling(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await api.testProvider(provider.id);
      setResult(r);
      if (r.ok) toast.success(`${provider.name}: reachable (${r.ms}ms)`);
      else toast.error(`${provider.name}: ${r.error || `status ${r.status}`}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card
      className={cn(
        "cursor-pointer gap-3 transition-colors hover:border-primary/50",
        !provider.enabled && "opacity-60",
      )}
      onClick={onOpen}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <ProviderIcon
            brand={provider.catalogId}
            name={provider.name}
            className="size-5"
          />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">
              <span className="inline-flex items-center gap-1.5">
                {provider.name}
                {provider.country && (
                  <CountryFlag code={provider.country} className="size-3.5" />
                )}
              </span>
            </div>
            <div className="truncate font-mono text-[0.7rem] text-muted-foreground">
              {provider.baseUrl}
            </div>
          </div>
        </div>
        <span
          className="shrink-0"
          onClick={(e) => e.stopPropagation()}
          role="presentation"
        >
          <Switch
            checked={provider.enabled}
            disabled={toggling}
            onCheckedChange={toggle}
            title={provider.enabled ? "Disable" : "Enable"}
          />
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary">{formatLabel(provider.format)}</Badge>
        <Badge
          variant={provider.nativeConversion ? "default" : "warning"}
          title={conversionHelp(provider.nativeConversion)}
        >
          {conversionLabel(provider.nativeConversion)}
        </Badge>
        <Badge variant="secondary">
          {plural(provider.apiKeys.length, "key")}
        </Badge>
        <Badge
          variant="secondary"
          title="Imported models in this provider's catalog"
        >
          {plural(provider.importedModelCount ?? 0, "model")} imported
        </Badge>
        {modelCount > 0 && (
          <Badge
            variant="secondary"
            title="Exposed-model fallback-chain hops routed through this provider"
          >
            {plural(modelCount, "route")}
          </Badge>
        )}
        {provider.proxy && <Badge variant="secondary">proxy</Badge>}
        {result && (
          <Badge variant={result.ok ? "success" : "destructive"}>
            {result.ok ? `${result.ms}ms` : "Failed"}
          </Badge>
        )}
      </div>

      <div
        className="mt-auto flex items-center justify-end gap-1 pt-1"
        onClick={(e) => e.stopPropagation()}
        role="presentation"
      >
        <Button variant="ghost" size="sm" onClick={test} disabled={testing}>
          {testing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Zap className="h-3.5 w-3.5" />
          )}
          Test
        </Button>
        <Link
          to={`/providers/${provider.id}/models`}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
          title="Imported models"
        >
          <Boxes className="h-3.5 w-3.5" />
          Models
        </Link>
        <Button variant="ghost" size="sm" onClick={onOpen}>
          <Pencil className="h-3.5 w-3.5" />
          Manage
        </Button>
      </div>
    </Card>
  );
});

// --- Detail dialog (tabbed) -------------------------------------------------
function ProviderDetail({
  provider,
  models,
  onClose,
  onChanged,
}: {
  provider: Provider;
  models: Model[];
  onClose: () => void;
  onChanged: () => void;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ProviderIcon
              brand={provider.catalogId}
              name={provider.name}
              className="size-5"
            />
            {provider.name}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {provider.baseUrl}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="config">Config</TabsTrigger>
            <TabsTrigger value="models">Models ({models.length})</TabsTrigger>
            <TabsTrigger value="advanced">Advanced</TabsTrigger>
          </TabsList>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <TabsContent value="overview">
              <OverviewTab provider={provider} modelCount={models.length} />
            </TabsContent>
            <TabsContent value="config">
              <ConfigForm
                provider={provider}
                onSaved={onChanged}
                section="config"
              />
            </TabsContent>
            <TabsContent value="models">
              <ModelsTab provider={provider} models={models} />
            </TabsContent>
            <TabsContent value="advanced">
              <ConfigForm
                provider={provider}
                onSaved={onChanged}
                section="advanced"
              />
              <DangerZone
                provider={provider}
                onDeleted={() => {
                  onChanged();
                  onClose();
                }}
              />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// --- Overview ---------------------------------------------------------------
function OverviewTab({
  provider,
  modelCount,
}: {
  provider: Provider;
  modelCount: number;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const test = async () => {
    setTesting(true);
    try {
      const r = await api.testProvider(provider.id);
      setResult(r);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTesting(false);
    }
  };
  const rows: Array<[string, React.ReactNode]> = [
    ["Status", provider.enabled ? "Enabled" : "Disabled"],
    ["Wire format", formatLabel(provider.format)],
    ["Endpoints", provider.endpoints.join(", ") || "—"],
    ["Auth scheme", authSchemeLabel(provider.authScheme)],
    ["Conversion", conversionLabel(provider.nativeConversion)],
    ["API keys", `${provider.apiKeys.length}`],
    ["Models routed", `${modelCount}`],
    [
      "Retries",
      `${provider.retryAttempts}× / ${Math.round(provider.retryIntervalMs / 1000)}s`,
    ],
    ["Timeout", `${Math.round(provider.requestTimeoutMs / 1000)}s`],
    ["TLS verification", provider.tlsVerify ? "On" : "Off"],
    ["Catalog", provider.catalogId ?? "—"],
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 border-b border-border/60 py-1.5">
            <span className="text-muted-foreground">{k}</span>
            <span className="text-right font-medium text-foreground">{v}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={test} disabled={testing}>
          {testing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Zap className="h-3.5 w-3.5" />
          )}
          Test connection
        </Button>
        {result && (
          <Badge variant={result.ok ? "success" : "destructive"}>
            {result.ok ? `Reachable · ${result.ms}ms` : result.error || "Failed"}
          </Badge>
        )}
      </div>
    </div>
  );
}

// --- Config form (migrated field editor) ------------------------------------
// Rendered in two sections so the same controlled form powers the Config tab
// (identity, wire format, keys) and the Advanced tab (retries, timeouts,
// headers, TLS). Each section has its own Save button that PUTs the full form.
function ConfigForm({
  provider,
  onSaved,
  section,
}: {
  provider: Provider;
  onSaved: () => void;
  section: "config" | "advanced";
}) {
  const [form, setForm] = useState<ProviderInput>(() => ({
    name: provider.name,
    baseUrl: provider.baseUrl,
    host: provider.host ?? "",
    authScheme: provider.authScheme,
    apiKeys: provider.apiKeys,
    retryAttempts: provider.retryAttempts,
    retryIntervalMs: provider.retryIntervalMs,
    requestTimeoutMs: provider.requestTimeoutMs,
    tlsVerify: provider.tlsVerify,
    enabled: provider.enabled,
    extraHeaders: provider.extraHeaders,
    format: provider.format,
    endpoints: provider.endpoints,
    nativeConversion: provider.nativeConversion,
    catalogId: provider.catalogId,
    basePath: provider.basePath,
    modelsPath: provider.modelsPath,
    proxy: provider.proxy,
    country: provider.country,
  }));
  const [keysText, setKeysText] = useState(provider.apiKeys.join("\n"));
  const [headersText, setHeadersText] = useState(
    JSON.stringify(provider.extraHeaders ?? {}, null, 2),
  );
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof ProviderInput>(k: K, v: ProviderInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const changeFormat = (fmt: ProviderFormat) =>
    setForm((f) => ({
      ...f,
      format: fmt,
      // Suffix style follows basePath: bare suffix when a basePath is set,
      // otherwise the legacy full /v1 path.
      endpoints: f.basePath
        ? fmt === "anthropic"
          ? ["/messages"]
          : ["/chat/completions"]
        : fmt === "anthropic"
          ? ["/v1/messages"]
          : ["/v1/chat/completions"],
    }));

  const removeEndpoint = (ep: string) =>
    setForm((f) => ({
      ...f,
      endpoints: (f.endpoints ?? []).filter((x) => x !== ep),
    }));

  const addEndpoint = (raw: string) => {
    const ep = raw.trim();
    if (!ep) return;
    const withLead = ep.startsWith("/") ? ep : "/" + ep;
    setForm((f) =>
      (f.endpoints ?? []).includes(withLead)
        ? f
        : { ...f, endpoints: [...(f.endpoints ?? []), withLead] },
    );
  };

  // Live preview of the composed upstream URL (origin + basePath + first suffix).
  const previewUrl = (() => {
    const origin = (form.baseUrl ?? "").replace(/\/+$/, "");
    const suffix = (form.endpoints ?? [])[0] ?? "";
    return origin + (form.basePath ?? "") + suffix;
  })();

  const save = async () => {
    setSaving(true);
    let extraHeaders: Record<string, string> = {};
    try {
      extraHeaders = headersText.trim() ? JSON.parse(headersText) : {};
    } catch {
      toast.error("Extra headers must be valid JSON");
      setSaving(false);
      return;
    }
    try {
      await api.updateProvider(provider.id, {
        ...form,
        apiKeys: keysText
          .split("\n")
          .map((k) => k.trim())
          .filter(Boolean),
        extraHeaders,
      });
      toast.success("Provider updated");
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const SaveBar = (
    <div className="flex justify-end pt-1">
      <Button onClick={save} disabled={saving || !form.name || !form.baseUrl}>
        {saving ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Check className="h-3.5 w-3.5" />
        )}
        {saving ? "Saving…" : "Save"}
      </Button>
    </div>
  );

  if (section === "config") {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name">
            <Input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </Field>
          <Field label="Base URL">
            <Input
              value={form.baseUrl}
              onChange={(e) => set("baseUrl", e.target.value)}
              className="font-mono"
            />
          </Field>
        </div>

        <div className="rounded-lg border border-border bg-card p-4 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Wire format"
              hint="anthropic = /v1/messages · openai = chat (and responses)"
            >
              <Select
                value={form.format}
                onValueChange={(v) => changeFormat(v as ProviderFormat)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI-Compatible</SelectItem>
                  <SelectItem value="anthropic">Anthropic-Compatible</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field
              label="Conversion policy"
              hint={conversionHelp(form.nativeConversion ?? false)}
            >
              <Select
                value={form.nativeConversion ? "native" : "gateway"}
                onValueChange={(v) => set("nativeConversion", v === "native")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gateway">Gateway converts</SelectItem>
                  <SelectItem value="native">Provider converts (native)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Base path"
              hint="Between origin and endpoint, e.g. /v1beta/openai (blank = none)"
            >
              <Input
                value={form.basePath ?? ""}
                onChange={(e) => set("basePath", e.target.value)}
                placeholder="/v1"
                className="font-mono"
              />
            </Field>
            <Field
              label="Models path"
              hint="For discovery / test — joined onto origin + base path"
            >
              <Input
                value={form.modelsPath ?? ""}
                onChange={(e) => set("modelsPath", e.target.value)}
                placeholder="/v1/models"
                className="font-mono"
              />
            </Field>
          </div>
          <div>
            <span className="text-xs font-medium text-foreground">
              Endpoint suffixes
            </span>
            <p className="mt-0.5 text-[0.65rem] text-muted-foreground">
              Appended to origin + base path. Must end in /chat/completions,
              /messages or /responses.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {(form.endpoints ?? []).map((ep) => (
                <span
                  key={ep}
                  className="inline-flex items-center gap-1 rounded-md border border-primary bg-primary/10 px-2 py-1 text-xs font-mono text-primary"
                >
                  {ep}
                  <button
                    type="button"
                    onClick={() => removeEndpoint(ep)}
                    className="cursor-pointer opacity-70 hover:opacity-100"
                    title="Remove"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <EndpointAdder onAdd={addEndpoint} />
            </div>
          </div>
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
            <span className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
              Upstream URL preview
            </span>
            <div className="mt-0.5 break-all font-mono text-xs text-foreground">
              {previewUrl || "—"}
            </div>
          </div>
        </div>

        <Field
          label="API keys"
          hint="one per line — rotated round-robin across requests"
        >
          <Textarea
            value={keysText}
            onChange={(e) => setKeysText(e.target.value)}
            rows={3}
            placeholder={"sk-…\nsk-…"}
            className="font-mono"
          />
        </Field>

        <label className="flex items-center gap-2">
          <Switch
            checked={form.enabled}
            onCheckedChange={(v) => set("enabled", v)}
          />
          <span className="text-xs font-medium text-muted-foreground normal-case">
            Enabled
          </span>
        </label>

        {SaveBar}
      </div>
    );
  }

  // advanced section
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Host header override" hint="blank = derive from base URL">
          <Input
            value={form.host ?? ""}
            onChange={(e) => set("host", e.target.value || null)}
          />
        </Field>
        <Field label="Auth scheme">
          <Select
            value={form.authScheme}
            onValueChange={(v) =>
              set("authScheme", v as ProviderInput["authScheme"])
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCHEMES.map((s) => (
                <SelectItem key={s} value={s}>
                  {authSchemeLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Field label="Retry attempts">
          <Input
            type="number"
            min={1}
            value={form.retryAttempts}
            onChange={(e) => set("retryAttempts", Number(e.target.value))}
          />
        </Field>
        <Field label="Retry interval (ms)">
          <Input
            type="number"
            min={0}
            value={form.retryIntervalMs}
            onChange={(e) => set("retryIntervalMs", Number(e.target.value))}
          />
        </Field>
        <Field label="Timeout (ms)">
          <Input
            type="number"
            min={1000}
            value={form.requestTimeoutMs}
            onChange={(e) => set("requestTimeoutMs", Number(e.target.value))}
          />
        </Field>
      </div>

      <Field label="Extra upstream headers" hint="JSON object — merged onto every request">
        <Textarea
          value={headersText}
          onChange={(e) => setHeadersText(e.target.value)}
          rows={3}
          className="font-mono"
          placeholder={'{\n  "anthropic-version": "2023-06-01"\n}'}
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Outbound proxy"
          hint="socks5://host:port or http://host:port — blank = direct"
        >
          <ProxyField
            value={form.proxy ?? ""}
            onChange={(v) => set("proxy", v || null)}
            testConfig={() => ({
              baseUrl: form.baseUrl,
              apiKey: (form.apiKeys ?? [])[0],
              authScheme: form.authScheme,
              basePath: form.basePath,
              modelsPath: form.modelsPath,
              proxy: form.proxy || null,
            })}
          />
        </Field>
        <Field label="Country" hint="Egress region tag (flag shown in the UI)">
          <CountryPicker
            value={form.country ?? ""}
            onChange={(v) => set("country", v || null)}
          />
        </Field>
      </div>

      <label className="flex items-center gap-2">
        <Switch
          checked={form.tlsVerify}
          onCheckedChange={(v) => set("tlsVerify", v)}
        />
        <span className="text-xs font-medium text-muted-foreground normal-case">
          TLS verification
        </span>
      </label>

      {SaveBar}
    </div>
  );
}

// Free-text endpoint-suffix adder: type a suffix, Enter to add.
function EndpointAdder({ onAdd }: { onAdd: (v: string) => void }) {
  const [val, setVal] = useState("");
  return (
    <input
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onAdd(val);
          setVal("");
        }
      }}
      placeholder="+ /chat/completions"
      className="h-7 w-40 rounded-md border border-dashed border-border bg-transparent px-2 text-xs font-mono placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none"
    />
  );
}

// Proxy input with a "Test" button that runs the pre-create probe through it.
function ProxyField({
  value,
  onChange,
  testConfig,
}: {
  value: string;
  onChange: (v: string) => void;
  testConfig: () => ProviderTestInput;
}) {
  const [testing, setTesting] = useState(false);
  const [ok, setOk] = useState<boolean | null>(null);
  const test = async () => {
    setTesting(true);
    setOk(null);
    try {
      const r = await api.testProviderConfig(testConfig());
      setOk(r.ok);
      if (r.ok) toast.success(`Reachable via proxy (${r.ms}ms)`);
      else toast.error(r.error || `status ${r.status}`);
    } catch (e) {
      setOk(false);
      toast.error((e as Error).message);
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="flex gap-2">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="socks5://127.0.0.1:1080"
        className="font-mono"
      />
      <Button variant="outline" size="sm" onClick={test} disabled={testing}>
        {testing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : ok === true ? (
          <Check className="h-3.5 w-3.5 text-success" />
        ) : (
          <Zap className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  );
}

// Country dropdown with an inline twemoji flag on the current value.
function CountryPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <CountryFlag code={value} />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-md border border-border bg-transparent px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
      >
        <option value="">— none —</option>
        {COUNTRIES.map((c) => (
          <option key={c.code} value={c.code}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}

// --- Models tab -------------------------------------------------------------
function ModelsTab({
  provider,
  models,
}: {
  provider: Provider;
  models: Model[];
}) {
  return (
    <div className="space-y-4">
      {/* Imported catalog — managed on its own page */}
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
          to={`/providers/${provider.id}/models`}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          <Download className="h-3.5 w-3.5" />
          Manage imports
        </Link>
      </div>

      {/* Exposed models routed through this provider */}
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
                    <TableCell className="font-medium">{m.alias}</TableCell>
                    <TableCell className="font-mono text-muted-foreground text-[0.7rem]">
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
                          size: "icon-sm",
                        })}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
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

// --- Danger zone (delete) ---------------------------------------------------
function DangerZone({
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
    <div className="mt-6 flex items-center justify-between rounded-lg border border-destructive/40 bg-destructive/5 p-3">
      <div>
        <div className="text-sm font-medium text-foreground">Delete provider</div>
        <div className="text-[0.7rem] text-muted-foreground">
          Removes this provider and its route from every model.
        </div>
      </div>
      <Button variant="destructive" size="sm" onClick={del} disabled={deleting}>
        {deleting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Trash2 className="h-3.5 w-3.5" />
        )}
        Delete
      </Button>
    </div>
  );
}
