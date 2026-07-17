// Provider-centric browser. Providers are shown as a responsive card grid;
// clicking a card navigates to the provider detail PAGE (./providers/detail).
// New providers are added through the stepped Add-Provider wizard
// (./providers/add-provider-dialog), which pre-fills config from the catalog.

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  Plus,
  Pencil,
  FlaskConical,
  Loader2,
  Boxes,
  KeyRound,
  Cpu,
} from "lucide-react";
import { toast } from "sonner";
import { Link, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import type { Model, Provider, ProviderTestResult } from "@/lib/types";
import { PageHeader, CardGridSkeleton } from "@/components/shared";
import { ProviderIcon } from "@/components/model-icon";
import { CountryFlag } from "@/components/country-flag";
import { AddProviderDialog } from "./providers/add-provider-dialog";
import { Card, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn, conversionLabel, conversionHelp, plural } from "@/lib/utils";

// Provider family groupings — order here is display order.
const FAMILY_RULES: Array<{
  label: string;
  brand: string;
  match: (p: Provider) => boolean;
}> = [
  {
    label: "Anthropic",
    brand: "anthropic",
    match: (p) => p.catalogId === "anthropic" || p.catalogId === "claude-code",
  },
  {
    label: "OpenAI",
    brand: "openai",
    match: (p) => p.catalogId === "openai",
  },
  {
    label: "DeepSeek",
    brand: "deepseek",
    match: (p) => p.catalogId === "deepseek",
  },
  {
    label: "Google",
    brand: "gemini",
    match: (p) => p.catalogId === "google-gemini",
  },
  {
    label: "NVIDIA",
    brand: "nvidia",
    match: (p) => p.catalogId === "nvidia-nim",
  },
  {
    label: "OpenRouter",
    brand: "openrouter",
    match: (p) => p.catalogId === "openrouter",
  },
  {
    label: "Z.ai",
    brand: "zai",
    match: (p) => p.catalogId === "glm-coding",
  },
  {
    label: "Ollama",
    brand: "ollama",
    match: (p) => p.catalogId === "ollama" || p.catalogId === "ollama-cloud",
  },
  {
    label: "NewAPI",
    brand: "newapi",
    match: (p) => p.catalogId === "newapi",
  },
  {
    label: "OpenCode",
    brand: "opencode",
    match: (p) => p.catalogId === "opencode",
  },
  {
    label: "Xiaomi",
    brand: "mimo",
    match: (p) => p.catalogId === "xiaomi-mimo",
  },
];

function groupProviders(
  providers: Provider[],
): Array<{ label: string; brand: string | null; items: Provider[] }> {
  const claimed = new Set<string>();
  const groups: Array<{
    label: string;
    brand: string | null;
    items: Provider[];
  }> = [];

  for (const rule of FAMILY_RULES) {
    const items = providers.filter((p) => rule.match(p) && !claimed.has(p.id));
    if (items.length) {
      groups.push({ label: rule.label, brand: rule.brand, items });
      items.forEach((p) => claimed.add(p.id));
    }
  }

  const rest = providers.filter((p) => !claimed.has(p.id));
  if (rest.length) groups.push({ label: "Custom", brand: null, items: rest });

  return groups;
}

export default function Providers() {
  const navigate = useNavigate();
  const [items, setItems] = useState<Provider[] | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [adding, setAdding] = useState(false);

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

  // Count of exposed-model chain hops routed through each provider (card badge).
  const modelCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const m of models)
      for (const link of m.providers)
        counts[link.providerId] = (counts[link.providerId] ?? 0) + 1;
    return counts;
  }, [models]);

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
        <CardGridSkeleton />
      ) : items.length === 0 ? (
        <SetupCard onStart={() => setAdding(true)} />
      ) : (
        <div className="space-y-6">
          {groupProviders(items).map((g) => (
            <section key={g.label}>
              <div className="mb-3 flex items-center gap-2">
                {g.brand && (
                  <ProviderIcon
                    brand={g.brand}
                    className="size-4 text-muted-foreground"
                  />
                )}
                <h2 className="text-sm font-medium text-muted-foreground">
                  {g.label}
                </h2>
                <Badge
                  variant="secondary"
                  className="px-1.5 py-0 text-[0.65rem]"
                >
                  {g.items.length}
                </Badge>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {g.items.map((p) => (
                  <ProviderCard
                    key={p.id}
                    provider={p}
                    modelCount={modelCounts[p.id] ?? 0}
                    onOpen={() => navigate(`/providers/${p.id}`)}
                    onChanged={load}
                  />
                ))}
              </div>
            </section>
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
    </div>
  );
}

// --- First-run setup card ---------------------------------------------------
// Shown when no providers exist yet: a short guided intro that launches the
// stepped Add-Provider wizard (pick from catalog → configure → test → import).
function SetupCard({ onStart }: { onStart: () => void }) {
  const steps = [
    {
      icon: Boxes,
      label: "Pick a provider",
      hint: "OpenAI, Anthropic, Gemini, NIM, a proxy…",
    },
    {
      icon: KeyRound,
      label: "Add your key",
      hint: "Paste a key; base URL is pre-filled",
    },
    {
      icon: FlaskConical,
      label: "Test the connection",
      hint: "One click, before you save",
    },
    {
      icon: Cpu,
      label: "Import models",
      hint: "Pull the upstream model list in",
    },
  ];
  return (
    <Card className="items-center gap-6 py-10 text-center">
      <div className="space-y-1">
        <h2 className="font-heading text-lg font-semibold text-foreground">
          Set up your first provider
        </h2>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">
          A provider is an upstream LLM endpoint the gateway routes to. The
          wizard walks you through it in four steps.
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
        "cursor-pointer gap-3 transition-all hover:border-primary/40 hover:shadow-sm",
        !provider.enabled && "opacity-60",
      )}
      onClick={onOpen}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <ProviderIcon
            brand={provider.catalogId ?? provider.format}
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
          // The toast on click already says WHY (see test() above); this badge
          // persists after the toast fades, so it needs to carry the same
          // status/error detail — never a bare, uninformative "Failed" (same
          // fix as overview-tab.tsx's "Test connection" badge).
          <Badge
            variant={result.ok ? "success" : "destructive"}
            title={result.sample}
          >
            {result.ok
              ? `${result.ms}ms`
              : `Failed${result.status ? ` (${result.status})` : ""}`}
          </Badge>
        )}
      </div>

      <CardFooter
        className="justify-end gap-1 mt-3"
        onClick={(e) => e.stopPropagation()}
        role="presentation"
      >
        <Button variant="soft" size="sm" onClick={test} disabled={testing}>
          {testing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FlaskConical className="h-3.5 w-3.5" />
          )}
          Test
        </Button>
        <Link
          to={`/providers/${provider.id}/imported`}
          className={buttonVariants({ variant: "soft", size: "sm" })}
          title="Imported models"
        >
          <Boxes className="h-3.5 w-3.5" />
          Imports
        </Link>
        <Button variant="soft" size="sm" onClick={onOpen}>
          <Pencil className="h-3.5 w-3.5" />
          Manage
        </Button>
      </CardFooter>
    </Card>
  );
});
