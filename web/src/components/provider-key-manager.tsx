import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  FlaskConical,
  Loader2,
  Pencil,
  Plus,
  Power,
  PowerOff,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ProviderKey, ProviderTestResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import { EmptyState, Field, TableSearch } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const ROW_HEIGHT = 52;
const GRID =
  "grid gap-3 grid-cols-[40px_minmax(100px,1fr)_52px_120px] md:grid-cols-[40px_minmax(200px,1.5fr)_minmax(96px,0.55fr)_104px_72px_120px]";

type MetadataEntry = { key: string; value: string };

function splitKeys(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((key) => key.trim())
    .filter(Boolean);
}

function uniqueKeys(raw: string): string[] {
  return [...new Set(splitKeys(raw))];
}

function mask(key: string): string {
  if (key.length <= 10) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function metadataEntries(metadata: Record<string, string>): MetadataEntry[] {
  return Object.entries(metadata).map(([key, value]) => ({ key, value }));
}

function buildMetadata(entries: MetadataEntry[]): {
  metadata?: Record<string, string>;
  error?: string;
} {
  const metadata: Record<string, string> = {};
  for (const entry of entries) {
    const key = entry.key.trim();
    if (!key) return { error: "Metadata keys cannot be blank" };
    if (Object.hasOwn(metadata, key))
      return { error: `Duplicate metadata key: ${key}` };
    metadata[key] = entry.value;
  }
  return { metadata };
}

export function ProviderKeyManager({
  providerId,
  onChanged,
}: {
  providerId: string;
  onChanged?: () => void;
}) {
  const [keys, setKeys] = useState<ProviderKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Map<string, ProviderTestResult>>(
    new Map(),
  );
  const [testingAll, setTestingAll] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ProviderKey | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const { keys: fetched } = await api.listProviderKeys(providerId);
      setKeys(fetched);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const reload = useCallback(async () => {
    await load();
    onChanged?.();
  }, [load, onChanged]);

  const filteredRows = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return keys;
    return keys.filter(
      (key) =>
        key.credential.toLowerCase().includes(query) ||
        key.label?.toLowerCase().includes(query) ||
        Object.entries(key.metadata).some(
          ([name, value]) =>
            name.toLowerCase().includes(query) ||
            value.toLowerCase().includes(query),
        ),
    );
  }, [keys, filter]);

  const enabledCount = useMemo(
    () => keys.filter((key) => key.enabled).length,
    [keys],
  );
  const disabledCount = keys.length - enabledCount;
  const visibleIds = useMemo(
    () => new Set(filteredRows.map((row) => row.id)),
    [filteredRows],
  );
  const visibleFailedIds = useMemo(
    () =>
      [...results.entries()]
        .filter(([id, result]) => visibleIds.has(id) && !result.ok)
        .map(([id]) => id),
    [results, visibleIds],
  );
  const selectedKeys = keys.filter((key) => selected.has(key.id));
  const canEnableSelected = selectedKeys.some((key) => !key.enabled);
  const canDisableSelected = selectedKeys.some((key) => key.enabled);
  const allVisibleSelected =
    filteredRows.length > 0 &&
    filteredRows.every((row) => selected.has(row.id));

  const virtualizer = useVirtualizer({
    count: filteredRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const testKey = useCallback(
    async (keyId: string) => {
      const key = keys.find((item) => item.id === keyId);
      if (!key) return undefined;
      setTesting((current) => new Set(current).add(keyId));
      try {
        const result = await api.testProvider(providerId, key.credential);
        setResults((current) => new Map(current).set(keyId, result));
        return result;
      } catch (error) {
        const result: ProviderTestResult = {
          ok: false,
          status: null,
          ms: 0,
          error: (error as Error).message,
        };
        setResults((current) => new Map(current).set(keyId, result));
        return result;
      } finally {
        setTesting((current) => {
          const next = new Set(current);
          next.delete(keyId);
          return next;
        });
      }
    },
    [keys, providerId],
  );

  const testAll = async () => {
    const queue = keys.filter((key) => key.enabled);
    if (!queue.length) return;
    setTestingAll(true);
    let passed = 0;
    const workers = Array.from(
      { length: Math.min(5, queue.length) },
      async () => {
        while (queue.length) {
          const key = queue.shift();
          if (!key) return;
          const result = await testKey(key.id);
          if (result?.ok) passed++;
        }
      },
    );
    try {
      await Promise.all(workers);
      toast[passed === enabledCount ? "success" : "error"](
        `${passed}/${enabledCount} active key(s) reachable`,
      );
    } finally {
      setTestingAll(false);
    }
  };

  const toggleKey = useCallback(
    async (keyId: string, enabled: boolean) => {
      setToggling((current) => new Set(current).add(keyId));
      try {
        await api.batchProviderKeys(providerId, {
          [enabled ? "enable" : "disable"]: [keyId],
        });
        setKeys((current) =>
          current.map((key) => (key.id === keyId ? { ...key, enabled } : key)),
        );
        onChanged?.();
      } catch (error) {
        toast.error((error as Error).message);
      } finally {
        setToggling((current) => {
          const next = new Set(current);
          next.delete(keyId);
          return next;
        });
      }
    },
    [onChanged, providerId],
  );

  const removeKey = useCallback(
    async (key: ProviderKey) => {
      if (!confirm(`Remove ${key.label || mask(key.credential)}?`)) return;
      try {
        await api.batchProviderKeys(providerId, { remove: [key.id] });
        setSelected((current) => {
          const next = new Set(current);
          next.delete(key.id);
          return next;
        });
        toast.success("Key removed");
        await reload();
      } catch (error) {
        toast.error((error as Error).message);
      }
    },
    [providerId, reload],
  );

  const runBulk = async (operation: "enable" | "disable" | "remove") => {
    const ids = [...selected].filter((id) => {
      const key = keys.find((item) => item.id === id);
      if (operation === "enable") return key && !key.enabled;
      if (operation === "disable") return key?.enabled;
      return true;
    });
    if (!ids.length) {
      toast.info(
        operation === "enable"
          ? "Selected keys are already active"
          : operation === "disable"
            ? "Selected keys are already disabled"
            : "No keys selected",
      );
      return;
    }
    if (
      operation === "remove" &&
      !confirm(
        `Remove ${ids.length} selected key${ids.length === 1 ? "" : "s"}?`,
      )
    )
      return;
    try {
      await api.batchProviderKeys(providerId, { [operation]: ids });
      setSelected(new Set());
      toast.success(
        `${ids.length} key${ids.length === 1 ? "" : "s"} ${
          operation === "remove" ? "removed" : `${operation}d`
        }`,
      );
      await reload();
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const toggleReveal = useCallback((keyId: string) => {
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(keyId)) next.delete(keyId);
      else next.add(keyId);
      return next;
    });
  }, []);

  const toggleSelect = useCallback((keyId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(keyId)) next.delete(keyId);
      else next.add(keyId);
      return next;
    });
  }, []);

  const selectFailed = () => {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of visibleFailedIds) next.add(id);
      return next;
    });
  };

  const toggleAllVisible = (checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const row of filteredRows) {
        if (checked) next.add(row.id);
        else next.delete(row.id);
      }
      return next;
    });
  };

  return (
    <>
      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          {selected.size > 0 ? (
            <>
              <span className="mr-1 text-xs font-medium">
                {selected.size} selected
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={!canEnableSelected}
                onClick={() => void runBulk("enable")}
              >
                <Power className="h-3.5 w-3.5" /> Enable
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!canDisableSelected}
                onClick={() => void runBulk("disable")}
              >
                <PowerOff className="h-3.5 w-3.5" /> Disable
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void runBulk("remove")}
              >
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </Button>
            </>
          ) : (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="success">{enabledCount} active</Badge>
              {disabledCount > 0 && (
                <Badge variant="secondary">{disabledCount} disabled</Badge>
              )}
              {visibleFailedIds.length > 0 && (
                <Button variant="ghost" size="sm" onClick={selectFailed}>
                  Select {visibleFailedIds.length} failed
                </Button>
              )}
            </div>
          )}
          <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none">
            <TableSearch
              value={filter}
              onChange={setFilter}
              placeholder="Search keys…"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => void testAll()}
              disabled={testingAll || enabledCount === 0}
            >
              {testingAll ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FlaskConical className="h-3.5 w-3.5" />
              )}
              <span className="hidden lg:inline">Test active</span>
            </Button>
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add keys
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading keys…
          </div>
        ) : keys.length === 0 ? (
          <EmptyState msg="No provider keys yet — add credentials to begin routing requests" />
        ) : filteredRows.length === 0 ? (
          <EmptyState msg="No keys match your search" />
        ) : (
          <div className="min-w-0">
            <div
              className={cn(
                GRID,
                "sticky top-0 z-10 h-8 items-center border-b border-border bg-muted/30 px-3 text-xs font-medium text-muted-foreground",
              )}
            >
              <div className="flex justify-start pr-2">
                <Checkbox
                  checked={allVisibleSelected}
                  onCheckedChange={(checked) => toggleAllVisible(!!checked)}
                  aria-label="Select all visible keys"
                />
              </div>
              <div>Key</div>
              <div className="hidden md:block">Tags</div>
              <div className="hidden text-center md:block">Test</div>
              <div className="text-center">Status</div>
              <div className="text-right">Actions</div>
            </div>
            <div ref={parentRef} className="max-h-[28rem] overflow-y-auto">
              <div
                style={{
                  height: `${virtualizer.getTotalSize()}px`,
                  position: "relative",
                }}
              >
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const key = filteredRows[virtualRow.index];
                  return (
                    <div
                      key={key.id}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: `${virtualRow.size}px`,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <ProviderKeyRow
                        providerKey={key}
                        selected={selected.has(key.id)}
                        revealed={revealed.has(key.id)}
                        testResult={results.get(key.id)}
                        testing={testing.has(key.id)}
                        toggling={toggling.has(key.id)}
                        onSelect={toggleSelect}
                        onToggle={toggleKey}
                        onReveal={toggleReveal}
                        onTest={testKey}
                        onEdit={setEditing}
                        onRemove={removeKey}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </Card>

      {adding && (
        <AddKeysDialog
          providerId={providerId}
          onClose={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false);
            await reload();
          }}
        />
      )}
      {editing && (
        <KeyEditDialog
          providerId={providerId}
          providerKey={editing}
          onClose={() => setEditing(null)}
          onRemoved={() => {
            setEditing(null);
            void reload();
          }}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </>
  );
}

interface ProviderKeyRowProps {
  providerKey: ProviderKey;
  selected: boolean;
  revealed: boolean;
  testResult?: ProviderTestResult;
  testing: boolean;
  toggling: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onReveal: (id: string) => void;
  onTest: (id: string) => void;
  onEdit: (key: ProviderKey) => void;
  onRemove: (key: ProviderKey) => void;
}

const ProviderKeyRow = memo(function ProviderKeyRow({
  providerKey: key,
  selected,
  revealed,
  testResult,
  testing,
  toggling,
  onSelect,
  onToggle,
  onReveal,
  onTest,
  onEdit,
  onRemove,
}: ProviderKeyRowProps) {
  const metadata = Object.entries(key.metadata);
  return (
    <div
      className={cn(
        GRID,
        "h-[52px] items-center border-b border-border/70 px-3 text-sm transition-colors hover:bg-muted/30",
        selected && "bg-primary/5",
        !key.enabled && "text-muted-foreground",
      )}
    >
      <div className="flex justify-start pr-2">
        <Checkbox
          checked={selected}
          onCheckedChange={() => onSelect(key.id)}
          aria-label={`Select ${mask(key.credential)}`}
        />
      </div>

      <div className="flex min-w-0 items-center gap-1 pr-3">
        <Button
          variant="ghost"
          size="sm"
          className="min-w-0 justify-start truncate px-0 font-mono text-sm text-foreground hover:bg-transparent md:hidden"
          onClick={() => onEdit(key)}
          title="Edit label and metadata"
        >
          {revealed ? key.credential : mask(key.credential)}
        </Button>
        <span className="hidden min-w-0 truncate font-mono text-sm text-foreground md:block">
          {revealed ? key.credential : mask(key.credential)}
        </span>
        <ActionButton
          label="Copy full credential"
          onClick={() => {
            void navigator.clipboard.writeText(key.credential);
            toast.success("Key copied");
          }}
        >
          <Copy />
        </ActionButton>
      </div>

      <div className="hidden min-w-0 items-center md:flex">
        <Button
          variant="ghost"
          size="sm"
          className="max-w-full justify-start gap-1.5 px-1 text-left"
          onClick={() => onEdit(key)}
          title="Edit label and metadata"
        >
          <span className="truncate text-sm font-medium text-foreground">
            {key.label || "Unlabeled"}
          </span>
          {metadata.length > 0 && (
            <Badge variant="secondary" className="shrink-0">
              <Tag className="mr-1 h-3 w-3" />
              {metadata.length}
            </Badge>
          )}
        </Button>
      </div>

      <div className="hidden text-center md:block">
        {testing ? (
          <Badge variant="secondary">
            <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Testing
          </Badge>
        ) : testResult ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Badge variant={testResult.ok ? "success" : "destructive"}>
                  {testResult.ok
                    ? `${testResult.ms} ms`
                    : testResult.status || "Failed"}
                </Badge>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-72">
              {testResult.ok
                ? "Credential is reachable"
                : testResult.error || "Credential test failed"}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-xs text-muted-foreground">Not tested</span>
        )}
      </div>

      <div className="flex items-center justify-center">
        <Switch
          checked={key.enabled}
          disabled={toggling}
          onCheckedChange={(enabled) => onToggle(key.id, enabled)}
          aria-label={`${key.enabled ? "Disable" : "Enable"} ${mask(key.credential)}`}
          title={
            toggling
              ? "Saving key status"
              : key.enabled
                ? "Active — click to disable"
                : "Disabled — click to enable"
          }
        />
      </div>

      <div className="flex items-center justify-end gap-0.5">
        <ActionButton
          label={revealed ? "Hide credential" : "Reveal credential"}
          onClick={() => onReveal(key.id)}
        >
          {revealed ? <EyeOff /> : <Eye />}
        </ActionButton>
        <ActionButton
          label="Test credential"
          disabled={testing}
          onClick={() => onTest(key.id)}
        >
          {testing ? <Loader2 className="animate-spin" /> : <FlaskConical />}
        </ActionButton>
        <ActionButton
          label="Edit label and metadata"
          onClick={() => onEdit(key)}
        >
          <Pencil />
        </ActionButton>
        <ActionButton
          label="Remove credential"
          destructive
          onClick={() => onRemove(key)}
        >
          <Trash2 />
        </ActionButton>
      </div>
    </div>
  );
});

function ActionButton({
  label,
  destructive,
  children,
  ...props
}: React.ComponentProps<typeof Button> & {
  label: string;
  destructive?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(
            "text-muted-foreground hover:text-foreground",
            destructive && "hover:text-destructive",
          )}
          aria-label={label}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function AddKeysDialog({
  providerId,
  onClose,
  onSaved,
}: {
  providerId: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [raw, setRaw] = useState("");
  const [label, setLabel] = useState("");
  const [entries, setEntries] = useState<MetadataEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const parsed = useMemo(() => uniqueKeys(raw), [raw]);
  const totalParsed = splitKeys(raw).length;

  const save = async () => {
    if (!parsed.length) return;
    const built = buildMetadata(entries);
    if (built.error) return toast.error(built.error);
    setSaving(true);
    try {
      const result = await api.batchProviderKeys(providerId, {
        add: parsed.map((credential) => ({
          credential,
          ...(label.trim() ? { label: label.trim() } : {}),
          ...(entries.length ? { metadata: built.metadata } : {}),
        })),
      });
      toast.success(
        `${result.added} key${result.added === 1 ? "" : "s"} added${
          result.duplicatesSkipped
            ? ` · ${result.duplicatesSkipped} duplicate${result.duplicatesSkipped === 1 ? "" : "s"} skipped`
            : ""
        }`,
      );
      await onSaved();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add provider keys</DialogTitle>
          <DialogDescription>
            Paste one key per line or separate keys with commas. Duplicates are
            skipped.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-4">
            <Field label="Keys">
              <Textarea
                value={raw}
                onChange={(event) => setRaw(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    (event.metaKey || event.ctrlKey) &&
                    event.key === "Enter"
                  ) {
                    event.preventDefault();
                    void save();
                  }
                }}
                rows={6}
                autoFocus
                placeholder={"sk-key-one\nsk-key-two"}
                className="font-mono text-sm"
              />
              <div className="mt-1 flex justify-between text-xs text-muted-foreground">
                <span>
                  {parsed.length} unique key{parsed.length === 1 ? "" : "s"}
                </span>
                {totalParsed > parsed.length && (
                  <span>
                    {totalParsed - parsed.length} duplicate input removed
                  </span>
                )}
              </div>
            </Field>
            <Field label="Shared label">
              <Input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Optional label applied to every key"
              />
            </Field>
          </div>

          <div className="border-t border-border pt-4">
            <MetadataFields entries={entries} onChange={setEntries} />
          </div>

          <DialogFooter className="border-t border-border pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={saving}
            >
              <X className="h-3.5 w-3.5" /> Cancel
            </Button>
            <Button type="submit" disabled={saving || !parsed.length}>
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              Add {parsed.length || ""} key{parsed.length === 1 ? "" : "s"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function KeyEditDialog({
  providerId,
  providerKey,
  onClose,
  onSaved,
  onRemoved,
}: {
  providerId: string;
  providerKey: ProviderKey;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onRemoved: () => void;
}) {
  const [label, setLabel] = useState(providerKey.label ?? "");
  const [enabled, setEnabled] = useState(providerKey.enabled);
  const [entries, setEntries] = useState<MetadataEntry[]>(() =>
    metadataEntries(providerKey.metadata),
  );
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  const save = async () => {
    const built = buildMetadata(entries);
    if (built.error) return toast.error(built.error);
    setSaving(true);
    try {
      await api.updateProviderKey(providerId, providerKey.id, {
        label: label.trim() || null,
        metadata: built.metadata,
        enabled,
      });
      toast.success("Key updated");
      await onSaved();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Remove ${label.trim() || mask(providerKey.credential)}?`))
      return;
    setRemoving(true);
    try {
      await api.deleteProviderKey(providerId, providerKey.id);
      toast.success("Key removed");
      onRemoved();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !saving && !removing && onClose()}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit provider key</DialogTitle>
          <DialogDescription>
            Update the key status and the tags exposed to provider adapters.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-4">
            <Field label="Key">
              <div className="relative">
                <Input
                  value={providerKey.credential}
                  readOnly
                  className="pr-10 font-mono text-sm"
                  aria-label="Full provider key"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Copy full key"
                  title="Copy full key"
                  className="absolute right-0.5 top-1/2 -translate-y-1/2"
                  onClick={() => {
                    void navigator.clipboard.writeText(providerKey.credential);
                    toast.success("Key copied");
                  }}
                >
                  <Copy />
                </Button>
              </div>
            </Field>
            <Field label="Label">
              <Input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Optional human-readable label"
                autoFocus
              />
            </Field>
            <label className="flex items-center gap-2 py-1">
              <Switch checked={enabled} onCheckedChange={setEnabled} />
              <span className="text-xs font-medium text-muted-foreground normal-case">
                Enabled
              </span>
            </label>
          </div>

          <div className="border-t border-border pt-4">
            <MetadataFields entries={entries} onChange={setEntries} />
          </div>

          <DialogFooter className="border-t border-border pt-4 justify-between sm:justify-between">
            <Button
              type="button"
              variant="destructive"
              onClick={() => void remove()}
              disabled={saving || removing}
            >
              {removing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Remove key
            </Button>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={saving || removing}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving || removing}>
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                Save changes
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MetadataFields({
  entries,
  onChange,
}: {
  entries: MetadataEntry[];
  onChange: (entries: MetadataEntry[]) => void;
}) {
  const add = () => onChange([...entries, { key: "", value: "" }]);
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-xs font-medium">Metadata</div>
          <div className="text-xs text-muted-foreground">
            Optional values such as uuid, email, tier, or region.
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={add}>
          <Plus className="h-3.5 w-3.5" /> Add field
        </Button>
      </div>
      {entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
          No metadata fields.
        </p>
      ) : (
        <div className="max-h-56 space-y-3 overflow-y-auto pr-1">
          {entries.map((entry, index) => (
            <div
              key={index}
              className="grid grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)_32px] gap-2"
            >
              <Input
                value={entry.key}
                onChange={(event) =>
                  onChange(
                    entries.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, key: event.target.value }
                        : item,
                    ),
                  )
                }
                placeholder="name"
                className="font-mono text-xs"
              />
              <Input
                value={entry.value}
                onChange={(event) =>
                  onChange(
                    entries.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, value: event.target.value }
                        : item,
                    ),
                  )
                }
                placeholder="value"
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Remove metadata field"
                className="text-muted-foreground hover:text-destructive"
                onClick={() =>
                  onChange(
                    entries.filter((_, itemIndex) => itemIndex !== index),
                  )
                }
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
