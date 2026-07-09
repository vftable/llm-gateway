// Add-Provider wizard — a stepped dialog that turns a catalog template into a
// configured, tested provider (and optionally imports its upstream models).
//
// Steps: Pick → Configure → Test → Import. The catalog pre-fills wire format,
// endpoints, auth scheme and required headers so the user usually only supplies
// a name + API key. Everything the wizard writes goes through the normal
// createProvider / createModel APIs — no special backend path.

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Zap,
  Loader2,
  ChevronDown,
} from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type {
  ProviderInput,
  ProviderTemplate,
  ProviderTestProbe,
} from "@/lib/types";
import { importModelsForProvider } from "./import-models";
import { Field, Stepper } from "@/components/shared";
import { ProviderIcon } from "@/components/model-icon";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn, formatLabel, authSchemeLabel, conversionLabel } from "@/lib/utils";

const STEPS = ["Pick", "Configure", "Test", "Import"];

export function AddProviderDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [step, setStep] = useState(0);
  const [templates, setTemplates] = useState<ProviderTemplate[] | null>(null);
  const [tpl, setTpl] = useState<ProviderTemplate | null>(null);

  // Config form (seeded from the chosen template's defaults).
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [keysText, setKeysText] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [headersText, setHeadersText] = useState("{}");

  // Test + import state.
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<ProviderTestProbe | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [modelFilter, setModelFilter] = useState("");
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    api.listProviderCatalog().then(setTemplates).catch(toast.error);
  }, []);

  const apiKeys = useMemo(
    () =>
      keysText
        .split("\n")
        .map((k) => k.trim())
        .filter(Boolean),
    [keysText],
  );

  const choose = (t: ProviderTemplate) => {
    setTpl(t);
    setName(t.id === "openai-compatible" || t.id === "anthropic-compatible" ? "" : t.id);
    setBaseUrl(t.defaults.baseUrl ?? "");
    setKeysText("");
    setProbe(null);
    setSelected(new Set());
    setHeadersText(
      JSON.stringify(
        { ...(t.quirks?.requiredHeaders ?? {}), ...(t.defaults.extraHeaders ?? {}) },
        null,
        2,
      ),
    );
    setShowAdvanced(false);
    setStep(1);
  };

  // Build the ProviderInput from template defaults + form values.
  const buildInput = (): ProviderInput | null => {
    if (!tpl) return null;
    let extraHeaders: Record<string, string> = {};
    try {
      extraHeaders = headersText.trim() ? JSON.parse(headersText) : {};
    } catch {
      toast.error("Extra headers must be valid JSON");
      return null;
    }
    return {
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      apiKeys,
      authScheme: tpl.defaults.authScheme ?? "bearer",
      format: tpl.defaults.format ?? "openai",
      endpoints: tpl.defaults.endpoints,
      nativeConversion: tpl.defaults.nativeConversion ?? false,
      extraHeaders,
      catalogId: tpl.id,
      // Carry the template's path layout so providers like Gemini route through
      // /v1beta/openai instead of the default /v1.
      basePath: tpl.defaults.basePath ?? "",
      modelsPath: tpl.defaults.modelsPath ?? "/v1/models",
      enabled: true,
    };
  };

  const runTest = async () => {
    if (!tpl) return;
    setTesting(true);
    setProbe(null);
    try {
      const r = await api.testProviderConfig({
        baseUrl: baseUrl.trim(),
        apiKey: apiKeys[0],
        authScheme: tpl.defaults.authScheme ?? "bearer",
        basePath: tpl.defaults.basePath ?? "",
        modelsPath: tpl.defaults.modelsPath ?? "/v1/models",
        extraHeaders: (() => {
          try {
            return headersText.trim() ? JSON.parse(headersText) : {};
          } catch {
            return {};
          }
        })(),
      });
      setProbe(r);
      if (r.ok)
        toast.success(
          `Reachable (${r.ms}ms)${r.models.length ? ` · ${r.models.length} models` : ""}`,
        );
      else toast.error(r.error || `status ${r.status}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const toggleModel = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Create the provider, then create/link the selected upstream models.
  const finish = async () => {
    const input = buildInput();
    if (!input) return;
    setFinishing(true);
    try {
      const provider = await api.createProvider(input);

      if (selected.size > 0) {
        const { created } = await importModelsForProvider(
          provider.id,
          selected,
        );
        toast.success(
          `${provider.name} added — ${created} model${created === 1 ? "" : "s"} imported`,
        );
      } else {
        toast.success(`${provider.name} added`);
      }
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setFinishing(false);
    }
  };

  // --- per-step validity ---
  const fieldReq = (key: string) => tpl?.fields.find((f) => f.key === key)?.required;
  const configValid =
    !!tpl &&
    (!fieldReq("name") || name.trim().length > 0) &&
    (!fieldReq("baseUrl") || baseUrl.trim().length > 0) &&
    (!fieldReq("apiKeys") || apiKeys.length > 0);

  const filteredModels = (probe?.models ?? []).filter((m) =>
    m.toLowerCase().includes(modelFilter.toLowerCase()),
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Add Provider</DialogTitle>
          <DialogDescription>
            Pick a provider, drop in your key, test, and optionally import models.
          </DialogDescription>
        </DialogHeader>

        <Stepper steps={STEPS} current={step} className="px-1" />

        <div className="flex-1 overflow-y-auto py-1 pr-1">
          {step === 0 && (
            <PickStep templates={templates} onPick={choose} />
          )}
          {step === 1 && tpl && (
            <ConfigStep
              tpl={tpl}
              name={name}
              setName={setName}
              baseUrl={baseUrl}
              setBaseUrl={setBaseUrl}
              keysText={keysText}
              setKeysText={setKeysText}
              showAdvanced={showAdvanced}
              setShowAdvanced={setShowAdvanced}
              headersText={headersText}
              setHeadersText={setHeadersText}
            />
          )}
          {step === 2 && tpl && (
            <TestStep
              testing={testing}
              probe={probe}
              baseUrl={baseUrl}
              onTest={runTest}
            />
          )}
          {step === 3 && (
            <ImportStep
              probe={probe}
              selected={selected}
              onToggle={toggleModel}
              filter={modelFilter}
              setFilter={setModelFilter}
              filtered={filteredModels}
              onAll={() => setSelected(new Set(probe?.models ?? []))}
              onNone={() => setSelected(new Set())}
            />
          )}
        </div>

        {/* footer nav */}
        <div className="flex items-center justify-between border-t border-border pt-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => (step === 0 ? onClose() : setStep(step - 1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            {step === 0 ? "Cancel" : "Back"}
          </Button>

          <div className="flex gap-2">
            {step === 1 && (
              <Button size="sm" disabled={!configValid} onClick={() => setStep(2)}>
                Next
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            )}
            {step === 2 && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={runTest}
                  disabled={testing}
                >
                  {testing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Zap className="h-3.5 w-3.5" />
                  )}
                  Test
                </Button>
                <Button size="sm" onClick={() => setStep(3)}>
                  {probe?.models.length ? "Import models" : "Skip"}
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
            {step === 3 && (
              <Button size="sm" onClick={finish} disabled={finishing}>
                {finishing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                {finishing
                  ? "Creating…"
                  : selected.size
                    ? `Create + import ${selected.size}`
                    : "Create provider"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// --- Step 1: pick a catalog template ---------------------------------------
function PickStep({
  templates,
  onPick,
}: {
  templates: ProviderTemplate[] | null;
  onPick: (t: ProviderTemplate) => void;
}) {
  if (!templates)
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading catalog…
      </div>
    );
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {templates.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onPick(t)}
          className="group flex items-start gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary/60 hover:bg-accent/40"
        >
          <ProviderIcon
            brand={t.brand}
            name={t.label}
            className="mt-0.5 size-5"
          />
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">
                {t.label}
              </span>
              <Badge variant="secondary">
                {formatLabel(t.defaults.format)}
              </Badge>
            </span>
            <span className="mt-0.5 block text-[0.7rem] leading-snug text-muted-foreground">
              {t.blurb}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

// --- Step 2: configure ------------------------------------------------------
function ConfigStep({
  tpl,
  name,
  setName,
  baseUrl,
  setBaseUrl,
  keysText,
  setKeysText,
  showAdvanced,
  setShowAdvanced,
  headersText,
  setHeadersText,
}: {
  tpl: ProviderTemplate;
  name: string;
  setName: (v: string) => void;
  baseUrl: string;
  setBaseUrl: (v: string) => void;
  keysText: string;
  setKeysText: (v: string) => void;
  showAdvanced: boolean;
  setShowAdvanced: (v: boolean) => void;
  headersText: string;
  setHeadersText: (v: string) => void;
}) {
  const nameField = tpl.fields.find((f) => f.key === "name");
  const baseField = tpl.fields.find((f) => f.key === "baseUrl");
  const keyField = tpl.fields.find((f) => f.key === "apiKeys");
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-3">
        <ProviderIcon brand={tpl.brand} name={tpl.label} className="size-5" />
        <div className="min-w-0">
          <div className="text-sm font-medium">{tpl.label}</div>
          <div className="text-[0.7rem] text-muted-foreground">{tpl.blurb}</div>
        </div>
        {tpl.docsUrl && (
          <a
            href={tpl.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-[0.7rem] text-primary underline-offset-2 hover:underline"
          >
            Docs
          </a>
        )}
      </div>

      {nameField && (
        <Field label={nameField.label} hint={nameField.hint}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={nameField.placeholder}
          />
        </Field>
      )}

      {baseField && (
        <Field label={baseField.label} hint={baseField.hint}>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={baseField.placeholder ?? tpl.defaults.baseUrl}
            className="font-mono"
            disabled={baseField.editable === false}
          />
        </Field>
      )}

      {keyField && (
        <Field label={keyField.label} hint={keyField.hint}>
          <Textarea
            value={keysText}
            onChange={(e) => setKeysText(e.target.value)}
            rows={2}
            placeholder={keyField.placeholder ?? "sk-…"}
            className="font-mono"
          />
        </Field>
      )}

      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              showAdvanced && "rotate-180",
            )}
          />
          Advanced
        </button>
        {showAdvanced && (
          <div className="mt-3 space-y-3 rounded-lg border border-border bg-card p-3">
            <div className="grid grid-cols-2 gap-3 text-[0.7rem]">
              <Meta
                label="Wire format"
                value={formatLabel(tpl.defaults.format ?? "openai")}
              />
              <Meta
                label="Auth scheme"
                value={authSchemeLabel(tpl.defaults.authScheme ?? "bearer")}
              />
              <Meta
                label="Endpoints"
                value={(tpl.defaults.endpoints ?? []).join(", ") || "—"}
              />
              <Meta
                label="Conversion"
                value={conversionLabel(tpl.defaults.nativeConversion ?? false)}
              />
            </div>
            <Field
              label="Extra headers"
              hint="JSON merged onto every upstream request"
            >
              <Textarea
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                rows={3}
                className="font-mono"
              />
            </Field>
            <p className="text-[0.65rem] text-muted-foreground">
              Fine-tune retries, timeouts and endpoints after creating the
              provider from its detail view.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="font-mono text-foreground">{value}</div>
    </div>
  );
}

// --- Step 3: test -----------------------------------------------------------
function TestStep({
  testing,
  probe,
  baseUrl,
  onTest,
}: {
  testing: boolean;
  probe: ProviderTestProbe | null;
  baseUrl: string;
  onTest: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-8 text-center">
      <div className="text-sm text-muted-foreground">
        Test connectivity to{" "}
        <span className="font-mono text-foreground">{baseUrl || "—"}</span>
      </div>
      {!probe && !testing && (
        <Button onClick={onTest}>
          <Zap className="h-3.5 w-3.5" /> Run test
        </Button>
      )}
      {testing && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Testing…
        </div>
      )}
      {probe && (
        <div className="w-full max-w-sm space-y-2">
          <div
            className={cn(
              "flex items-center justify-center gap-2 rounded-lg border p-3 text-sm",
              probe.ok
                ? "border-success/40 bg-success/10 text-foreground"
                : "border-destructive/40 bg-destructive/10 text-foreground",
            )}
          >
            {probe.ok ? (
              <>
                <Check className="h-4 w-4" /> Reachable · {probe.ms}ms
                {probe.models.length > 0 && ` · ${probe.models.length} models`}
              </>
            ) : (
              <>Failed — {probe.error || `status ${probe.status}`}</>
            )}
          </div>
          <p className="text-[0.7rem] text-muted-foreground">
            The test isn't required — you can skip and create the provider
            anyway.
          </p>
        </div>
      )}
    </div>
  );
}

// --- Step 4: import models --------------------------------------------------
function ImportStep({
  probe,
  selected,
  onToggle,
  filter,
  setFilter,
  filtered,
  onAll,
  onNone,
}: {
  probe: ProviderTestProbe | null;
  selected: Set<string>;
  onToggle: (id: string) => void;
  filter: string;
  setFilter: (v: string) => void;
  filtered: string[];
  onAll: () => void;
  onNone: () => void;
}) {
  const models = probe?.models ?? [];
  if (models.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        No upstream models discovered. You can create the provider now and add
        models later from its detail view.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter models…"
          className="font-mono"
        />
        <Button variant="ghost" size="sm" onClick={onAll}>
          All
        </Button>
        <Button variant="ghost" size="sm" onClick={onNone}>
          None
        </Button>
      </div>
      <div className="text-[0.7rem] text-muted-foreground">
        {selected.size} of {models.length} selected — new aliases are imported
        disabled (enable the ones you want public on the Models page); existing
        ones gain this provider as a fallback.
      </div>
      <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-border p-1">
        {filtered.map((m) => {
          const on = selected.has(m);
          return (
            <button
              key={m}
              type="button"
              onClick={() => onToggle(m)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-mono transition-colors",
                on
                  ? "bg-primary/10 text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded border",
                  on ? "border-primary bg-primary text-primary-foreground" : "border-border",
                )}
              >
                {on && <Check className="h-3 w-3" />}
              </span>
              {m}
            </button>
          );
        })}
      </div>
    </div>
  );
}
