// Provider detail — a routed page (/providers/:id) with section tabs.
//
// Replaces the old in-grid ProviderDetail dialog: a chain/config is too much for
// a modal. Overview · Config · Keys · Models · Advanced via the shared
// SectionTabs. The tab param is in the URL (/providers/:id/:tab) so a tab is
// linkable and survives refresh.
//
// Split across sibling files by tab:
//   overview-tab.tsx  — OverviewTab (summary rows, connectivity test, recent errors)
//   keys-tab.tsx      — KeysTab (bulk key manager + per-key usage)
//   config-form.tsx   — ConfigForm (Config + Advanced sections)
//   models-tab.tsx    — ModelsTab + DangerZone

import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Model, Provider } from "@/lib/types";
import {
  PageHeader,
  PageSkeleton,
  EmptyState,
  BackLink,
  SectionTabs,
} from "@/components/shared";
import { ProviderIcon } from "@/components/model-icon";
import { Badge } from "@/components/ui/badge";
import { OverviewTab } from "./overview-tab";
import { KeysTab } from "./keys-tab";
import { ConfigForm } from "./config-form";
import { ModelsTab, DangerZone } from "./models-tab";

type TabId = "overview" | "config" | "keys" | "models" | "advanced";
const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "config", label: "Config" },
  { id: "keys", label: "Keys" },
  { id: "models", label: "Models" },
  { id: "advanced", label: "Advanced" },
];

export default function ProviderDetailPage() {
  const { id = "", tab } = useParams();
  const navigate = useNavigate();
  const [provider, setProvider] = useState<Provider | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(() => {
    api
      .listProviders()
      .then((ps) => {
        const p = ps.find((x) => x.id === id) ?? null;
        setProvider(p);
        if (!p) setNotFound(true);
      })
      .catch((e) => toast.error((e as Error).message));
    api
      .listModels()
      .then(setModels)
      .catch(() => {});
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  const routed = models.filter((m) =>
    m.providers.some((l) => l.providerId === id),
  );
  const active: TabId = (
    TABS.some((t) => t.id === tab) ? tab : "overview"
  ) as TabId;

  if (notFound)
    return (
      <div className="space-y-4">
        <BackLink to="/providers" label="Back to Providers" />
        <EmptyState msg="Provider not found" />
      </div>
    );
  if (!provider)
    return (
      <div className="space-y-4">
        <BackLink to="/providers" label="Back to Providers" />
        <PageSkeleton tabs={TABS.length} />
      </div>
    );

  return (
    <div className="space-y-4">
      <BackLink to="/providers" label="Back to Providers" />
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            <ProviderIcon
              brand={provider.catalogId}
              name={provider.name}
              className="size-5"
            />
            {provider.name}
          </span>
        }
        desc={provider.baseUrl}
      />

      <SectionTabs
        sections={TABS.map((t) =>
          t.id === "models"
            ? {
                ...t,
                badge: <Badge variant="secondary">{routed.length}</Badge>,
              }
            : t.id === "keys"
              ? {
                  ...t,
                  badge: (
                    <Badge variant="secondary">{provider.apiKeys.length}</Badge>
                  ),
                }
              : t,
        )}
        active={active}
        onChange={(t) => navigate(`/providers/${id}/${t}`)}
      />

      <div className="pt-1">
        {active === "overview" && (
          <OverviewTab provider={provider} modelCount={routed.length} />
        )}
        {active === "config" && (
          <ConfigForm provider={provider} onSaved={load} section="config" />
        )}
        {active === "keys" && <KeysTab provider={provider} onSaved={load} />}
        {active === "models" && (
          <ModelsTab provider={provider} models={routed} />
        )}
        {active === "advanced" && (
          <>
            <ConfigForm provider={provider} onSaved={load} section="advanced" />
            <DangerZone
              provider={provider}
              onDeleted={() => navigate("/providers")}
            />
          </>
        )}
      </div>
    </div>
  );
}
