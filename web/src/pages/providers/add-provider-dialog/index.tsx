// Add-Provider wizard — a stepped dialog that turns a catalog template into a
// configured, tested provider (and optionally imports its upstream models).
//
// Steps: Pick → Configure → Test → Import. The catalog pre-fills wire format,
// endpoints, auth scheme and required headers so the user usually only supplies
// a name + API key. Everything the wizard writes goes through the normal
// createProvider / createModel APIs — no special backend path.
//
// Split across sibling files by step:
//   pick-step.tsx    — PickStep (choose a catalog template)
//   config-step.tsx  — ConfigStep (name/baseUrl/keys + Advanced)
//   test-step.tsx    — TestStep (connectivity result)
//   import-step.tsx  — ImportStep (bulk-select upstream models)

import { useEffect, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type {
  ProviderInput,
  ProviderTemplate,
  ProviderTestProbe,
} from "@/lib/types";
import { importModelsForProvider } from "../import-models";
import { Stepper } from "@/components/shared";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PickStep } from "./pick-step";
import { ConfigStep } from "./config-step";
import { TestStep } from "./test-step";
import { ImportStep } from "./import-step";

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
  const [basePath, setBasePath] = useState("");
  const [apiKeys, setApiKeys] = useState<string[]>([]);
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

  const choose = (t: ProviderTemplate) => {
    setTpl(t);
    setName(
      t.id === "openai-compatible" || t.id === "anthropic-compatible"
        ? ""
        : t.id,
    );
    setBaseUrl(t.defaults.baseUrl ?? "");
    setBasePath(t.defaults.basePath ?? "");
    setApiKeys([]);
    setProbe(null);
    setSelected(new Set());
    setHeadersText(
      JSON.stringify(
        {
          ...(t.quirks?.requiredHeaders ?? {}),
          ...(t.defaults.extraHeaders ?? {}),
        },
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
      // format is a nullable generic hint; adapter-backed templates omit it and
      // the adapter identifies itself (null passes through).
      format: tpl.defaults.format ?? null,
      endpoints: tpl.defaults.endpoints,
      endpointPaths: tpl.defaults.endpointPaths,
      nativeConversion: tpl.defaults.nativeConversion ?? false,
      extraHeaders,
      catalogId: tpl.id,
      // basePath REPLACES the implicit "/v1" prefix (see resolvedUrlPreview) —
      // seeded from the template (e.g. Gemini ships "/v1beta/openai") but
      // editable in Advanced for a non-standard deployment (self-hosted gateway,
      // reverse proxy under a path prefix, etc).
      basePath: basePath.trim(),
      modelsPath: tpl.defaults.modelsPath ?? "/v1/models",
      enabled: true,
    };
  };

  const runTest = async () => {
    if (!tpl || apiKeys.length === 0) return;
    setTesting(true);
    setProbe(null);
    const key = apiKeys[Math.floor(Math.random() * apiKeys.length)];
    try {
      const r = await api.testProviderConfig({
        baseUrl: baseUrl.trim(),
        apiKey: key,
        authScheme: tpl.defaults.authScheme ?? "bearer",
        basePath: basePath.trim(),
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
        // Resolve selected ids back to the rich discovered models so metadata
        // (context/max-out/capabilities) is imported, not just the id.
        const chosen = (probe?.models ?? []).filter((m) => selected.has(m.id));
        const { created } = await importModelsForProvider(provider.id, chosen);
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
  const fieldReq = (key: string) =>
    tpl?.fields.find((f) => f.key === key)?.required;
  const configValid =
    !!tpl &&
    (!fieldReq("name") || name.trim().length > 0) &&
    (!fieldReq("baseUrl") || baseUrl.trim().length > 0) &&
    (!fieldReq("apiKeys") || apiKeys.length > 0);

  const filteredModels = (probe?.models ?? []).filter((m) =>
    (m.id + " " + (m.displayName ?? ""))
      .toLowerCase()
      .includes(modelFilter.toLowerCase()),
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Add Provider</DialogTitle>
          <DialogDescription>
            Pick a provider, drop in your key, test, and optionally import
            models.
          </DialogDescription>
        </DialogHeader>

        <Stepper steps={STEPS} current={step} className="px-1" />

        <div className="flex-1 overflow-y-auto py-1 pr-1">
          {step === 0 && <PickStep templates={templates} onPick={choose} />}
          {step === 1 && tpl && (
            <ConfigStep
              tpl={tpl}
              name={name}
              setName={setName}
              baseUrl={baseUrl}
              setBaseUrl={setBaseUrl}
              basePath={basePath}
              setBasePath={setBasePath}
              apiKeys={apiKeys}
              setApiKeys={setApiKeys}
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
              basePath={basePath}
              modelsPath={tpl.defaults.modelsPath ?? "/v1/models"}
              endpoints={tpl.defaults.endpoints}
              endpointPaths={tpl.defaults.endpointPaths}
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
              onAll={() =>
                setSelected(new Set((probe?.models ?? []).map((m) => m.id)))
              }
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
              <Button
                size="sm"
                disabled={!configValid}
                onClick={() => setStep(2)}
              >
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
                    <FlaskConical className="h-3.5 w-3.5" />
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
