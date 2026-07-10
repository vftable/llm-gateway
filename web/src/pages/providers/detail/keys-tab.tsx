// Keys tab: bulk key manager + save, plus the per-key upstream usage panel.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Provider, ProviderUsageReport } from "@/lib/types";
import { KeyUsageBlock } from "../usage";
import { UsageBlockGridSkeleton, FormSection } from "@/components/shared";
import { KeyManager } from "@/components/key-manager";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function KeysTab({
  provider,
  onSaved,
}: {
  provider: Provider;
  onSaved: () => void;
}) {
  const [keys, setKeys] = useState<string[]>(provider.apiKeys);
  const [disabledKeys, setDisabledKeys] = useState<string[]>(
    provider.disabledApiKeys ?? [],
  );
  const [saving, setSaving] = useState(false);
  const dirty = useMemo(
    () =>
      JSON.stringify(keys) !== JSON.stringify(provider.apiKeys) ||
      JSON.stringify(disabledKeys) !==
        JSON.stringify(provider.disabledApiKeys ?? []),
    [keys, disabledKeys, provider.apiKeys, provider.disabledApiKeys],
  );
  const save = async () => {
    setSaving(true);
    try {
      await api.updateProvider(provider.id, {
        apiKeys: keys,
        disabledApiKeys: disabledKeys,
      });
      toast.success("Keys updated");
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="max-w-3xl space-y-4">
      <KeyManager
        value={keys}
        disabled={disabledKeys}
        onChange={(en, dis) => {
          setKeys(en);
          setDisabledKeys(dis);
        }}
        providerId={provider.id}
      />
      <div className="flex justify-end">
        <Button onClick={save} disabled={saving || !dirty}>
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          {saving ? "Saving…" : "Save keys"}
        </Button>
      </div>
      <KeyUsagePanel providerId={provider.id} />
    </div>
  );
}

// Per-key upstream usage for this provider, fed by the adapter's async
// keyUsage() (the client awaits the request). Refreshes on demand.
function KeyUsagePanel({ providerId }: { providerId: string }) {
  const [report, setReport] = useState<ProviderUsageReport | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await api.providerUsageOne(providerId));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <FormSection
      title="Usage"
      desc="Upstream token + request quota per key, reported live by the provider adapter."
    >
      <div className="space-y-3 px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {report && !report.supported
              ? "Not reported"
              : report?.dummy
                ? "Estimated (no live usage endpoint)"
                : "Live"}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", loading && "animate-spin")}
            />
            Refresh
          </Button>
        </div>
        {!report ? (
          <UsageBlockGridSkeleton />
        ) : !report.supported ? (
          <p className="text-xs text-muted-foreground">
            This provider does not report upstream key usage.
          </p>
        ) : report.keys.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No keys to report usage for.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {report.keys.map((k, i) => (
              <KeyUsageBlock key={i} usage={k} />
            ))}
          </div>
        )}
      </div>
    </FormSection>
  );
}
