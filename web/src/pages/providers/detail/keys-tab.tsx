// Keys tab: self-managing provider key manager with URL import,
// background poll configuration, and per-key upstream usage.

import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  Download,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type {
  Provider,
  ProviderKeySyncConfig,
  ProviderUsageReport,
} from "@/lib/types";
import { KeyUsageBlock, sortByLastUsed } from "../usage";
import { UsageBlockGridSkeleton, FormSection } from "@/components/shared";
import { ProviderKeyManager } from "@/components/provider-key-manager";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function KeysTab({
  provider,
  onSaved,
}: {
  provider: Provider;
  onSaved: () => void;
}) {
  return (
    <div className="space-y-6">
      <ProviderKeyManager providerId={provider.id} onChanged={onSaved} />
      <div className="max-w-3xl space-y-6">
        <ImportSection providerId={provider.id} onImported={onSaved} />
        <SyncConfigSection providerId={provider.id} onChanged={onSaved} />
        <KeyUsagePanel providerId={provider.id} />
      </div>
    </div>
  );
}

// --- URL import (one-shot) ---

function ImportSection({
  providerId,
  onImported,
}: {
  providerId: string;
  onImported: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<"append" | "replace">("append");
  const [importing, setImporting] = useState(false);

  const run = async () => {
    if (!url.trim()) return;
    setImporting(true);
    try {
      const result = await api.importProviderKeys(providerId, {
        url: url.trim(),
        mode,
      });
      toast.success(
        `Imported ${result.fetched} key(s) — ${result.batch.added} added, ${result.batch.duplicatesSkipped} skipped`,
      );
      setUrl("");
      onImported();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <FormSection
      title="Import from URL"
      desc="Fetch keys from an external endpoint. Accepts JSON arrays or newline-delimited text."
    >
      <div className="px-4 py-3 space-y-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen(!open)}
          className="-ml-2 text-muted-foreground"
        >
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              open && "rotate-180",
            )}
          />
          Import keys from a URL
        </Button>

        {open && (
          <div className="space-y-2">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-backend.example.com/api/keys"
              className="font-mono text-xs"
            />
            <div className="flex items-center gap-3">
              <Select
                value={mode}
                onValueChange={(value) =>
                  setMode(value as "append" | "replace")
                }
              >
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="append">Append</SelectItem>
                  <SelectItem value="replace">Replace</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">
                {mode === "replace"
                  ? "Keys not in the response are disabled (not deleted)"
                  : "New keys are added; existing keys are untouched"}
              </span>
            </div>
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={() => void run()}
                disabled={importing || !url.trim()}
              >
                {importing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {importing ? "Importing…" : "Import"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </FormSection>
  );
}

// --- Background poll / sync config ---

function SyncConfigSection({
  providerId,
  onChanged,
}: {
  providerId: string;
  onChanged: () => void;
}) {
  const [config, setConfig] = useState<ProviderKeySyncConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);

  // Edit state
  const [pollUrl, setPollUrl] = useState("");
  const [interval, setInterval_] = useState(300);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [triggering, setTriggering] = useState(false);

  const load = useCallback(async () => {
    try {
      const c = await api.getProviderKeySync(providerId);
      setConfig(c);
      if (c) {
        setPollUrl(c.pollUrl);
        setInterval_(c.pollIntervalSec);
        setEnabled(c.enabled);
      }
    } catch {
      // no config
    } finally {
      setLoaded(true);
    }
  }, [providerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!pollUrl.trim()) return;
    setSaving(true);
    try {
      const updated = await api.updateProviderKeySync(providerId, {
        pollUrl: pollUrl.trim(),
        pollIntervalSec: Math.max(30, interval),
        enabled,
      });
      setConfig(updated);
      toast.success("Sync config saved");
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await api.deleteProviderKeySync(providerId);
      setConfig(null);
      setPollUrl("");
      setInterval_(300);
      setEnabled(true);
      toast.success("Sync config removed");
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const trigger = async () => {
    setTriggering(true);
    try {
      const result = await api.triggerProviderKeySync(providerId);
      toast.success(
        `Synced ${result.fetched} key(s) — ${result.batch.added} added, ${result.batch.enabled} re-enabled, ${result.batch.disabled} disabled`,
      );
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTriggering(false);
    }
  };

  if (!loaded) return null;

  return (
    <FormSection
      title="Background polling"
      desc="Automatically sync keys from an external source on a schedule. The URL response is the source of truth — missing keys are disabled, not deleted."
    >
      <div className="px-4 py-3 space-y-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen(!open)}
          className="-ml-2 text-muted-foreground"
        >
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              open && "rotate-180",
            )}
          />
          Poll configuration
          {config && (
            <Badge
              variant={config.enabled ? "success" : "secondary"}
              className="ml-1.5"
            >
              {config.enabled ? "Active" : "Paused"}
            </Badge>
          )}
        </Button>

        {open && (
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                Poll URL
              </label>
              <Input
                value={pollUrl}
                onChange={(e) => setPollUrl(e.target.value)}
                placeholder="https://your-backend.example.com/api/keys"
                className="font-mono text-xs"
              />
            </div>
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <label className="mb-1 block text-xs text-muted-foreground">
                  Interval (seconds)
                </label>
                <Input
                  type="number"
                  min={30}
                  value={interval}
                  onChange={(e) =>
                    setInterval_(parseInt(e.target.value) || 300)
                  }
                  className="w-28 text-xs"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Enabled</span>
                <Switch checked={enabled} onCheckedChange={setEnabled} />
              </div>
            </div>

            {config && (
              <div className="text-xs text-muted-foreground space-y-0.5">
                <div>
                  Last synced:{" "}
                  {config.lastSyncedAt
                    ? new Date(config.lastSyncedAt).toLocaleString()
                    : "never"}
                </div>
                {config.lastSyncError && (
                  <div className="text-destructive">
                    Last error: {config.lastSyncError}
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center justify-between pt-1">
              <div className="flex gap-1.5">
                {config && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void trigger()}
                      disabled={triggering}
                    >
                      {triggering ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                      Sync now
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void remove()}
                      className="text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Remove
                    </Button>
                  </>
                )}
              </div>
              <Button
                size="sm"
                onClick={() => void save()}
                disabled={saving || !pollUrl.trim()}
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {config ? "Update" : "Enable polling"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </FormSection>
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
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 [&>*:last-child:nth-child(odd)]:col-span-2">
            {(() => {
              // Freshest-first; green-outline the most-recently-used key. This
              // detail view keeps rate-limited keys visible (it's the key
              // manager) — only the dashboard hides them behind a toggle.
              const sorted = sortByLastUsed(report.keys);
              const highlightMask = sorted.find((k) => k.lastUsedAt)?.keyMask;
              return sorted.map((k, i) => (
                <KeyUsageBlock
                  key={i}
                  usage={k}
                  highlight={k.keyMask === highlightMask}
                />
              ));
            })()}
          </div>
        )}
      </div>
    </FormSection>
  );
}
