import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Check,
  FlaskConical,
  Loader2,
  Power,
  PowerOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TableSearch } from "@/components/shared";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import type { ProviderTestResult } from "@/lib/types";
import { toast } from "sonner";

function splitKeys(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((k) => k.trim())
    .filter(Boolean);
}

function mask(key: string): string {
  if (key.length <= 10) return key.slice(0, 2) + "…";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export interface AdhocTestConfig {
  baseUrl: string;
  authScheme: string;
  basePath?: string;
  modelsPath?: string;
  extraHeaders?: Record<string, string>;
}

export function KeyManager({
  value,
  disabled = [],
  onChange,
  providerId,
  adhocTestConfig,
}: {
  value: string[];
  disabled?: string[];
  onChange: (enabled: string[], disabled: string[]) => void;
  providerId?: string;
  adhocTestConfig?: AdhocTestConfig;
}) {
  const [bulk, setBulk] = useState("");
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Map<string, ProviderTestResult>>(
    new Map(),
  );
  const [testingAll, setTestingAll] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");

  const parentRef = useRef<HTMLDivElement>(null);

  const allRows = useMemo(
    () => [
      ...value.map((k) => ({ key: k, on: true })),
      ...disabled.map((k) => ({ key: k, on: false })),
    ],
    [value, disabled],
  );

  const filteredRows = useMemo(() => {
    if (!filter) return allRows;
    const q = filter.toLowerCase();
    return allRows.filter((r) => r.key.toLowerCase().includes(q));
  }, [allRows, filter]);

  const virtualizer = useVirtualizer({
    count: filteredRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 20,
  });

  const canTest = !!(providerId || adhocTestConfig);

  const testKey = useCallback(
    async (key: string) => {
      if (!providerId) return undefined;
      setTesting((t) => new Set(t).add(key));
      try {
        const r = await api.testProvider(providerId, key);
        setResults((m) => new Map(m).set(key, r));
        return r;
      } catch (e) {
        const r: ProviderTestResult = {
          ok: false,
          status: null,
          ms: 0,
          error: (e as Error).message,
        };
        setResults((m) => new Map(m).set(key, r));
        return r;
      } finally {
        setTesting((t) => {
          const n = new Set(t);
          n.delete(key);
          return n;
        });
      }
    },
    [providerId],
  );

  const testKeyAdhoc = useCallback(
    async (key: string) => {
      if (!adhocTestConfig) return undefined;
      setTesting((t) => new Set(t).add(key));
      try {
        const r = await api.testProviderConfig({
          baseUrl: adhocTestConfig.baseUrl,
          apiKey: key,
          authScheme: adhocTestConfig.authScheme as "bearer",
          basePath: adhocTestConfig.basePath,
          modelsPath: adhocTestConfig.modelsPath,
          extraHeaders: adhocTestConfig.extraHeaders,
        });
        const result: ProviderTestResult = {
          ok: r.ok,
          status: r.status,
          ms: r.ms,
          error: r.error,
        };
        setResults((m) => new Map(m).set(key, result));
        return result;
      } catch (e) {
        const result: ProviderTestResult = {
          ok: false,
          status: null,
          ms: 0,
          error: (e as Error).message,
        };
        setResults((m) => new Map(m).set(key, result));
        return result;
      } finally {
        setTesting((t) => {
          const n = new Set(t);
          n.delete(key);
          return n;
        });
      }
    },
    [adhocTestConfig],
  );

  const doTest = useCallback(
    (key: string) => (providerId ? testKey(key) : testKeyAdhoc(key)),
    [providerId, testKey, testKeyAdhoc],
  );

  const testAll = async () => {
    if (value.length === 0) return;
    setTestingAll(true);
    let okCount = 0;
    try {
      for (const key of value) {
        const r = await doTest(key);
        if (r?.ok) okCount++;
      }
      toast[okCount === value.length ? "success" : "error"](
        `${okCount}/${value.length} key(s) reachable`,
      );
    } finally {
      setTestingAll(false);
    }
  };

  const addBulk = () => {
    const incoming = splitKeys(bulk);
    if (incoming.length === 0) return;
    const seen = new Set([...value, ...disabled]);
    const nextEnabled = [...value];
    for (const k of incoming) {
      if (!seen.has(k)) {
        seen.add(k);
        nextEnabled.push(k);
      }
    }
    onChange(nextEnabled, disabled);
    setBulk("");
  };

  const remove = useCallback(
    (key: string) => {
      onChange(
        value.filter((k) => k !== key),
        disabled.filter((k) => k !== key),
      );
      setSelected((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    },
    [value, disabled, onChange],
  );

  const toggle = useCallback(
    (key: string, on: boolean) => {
      if (on) {
        onChange(
          value.filter((k) => k !== key),
          [...disabled, key],
        );
      } else {
        onChange(
          [...value, key],
          disabled.filter((k) => k !== key),
        );
      }
    },
    [value, disabled, onChange],
  );

  const toggleReveal = useCallback(
    (key: string) =>
      setRevealed((r) => {
        const n = new Set(r);
        if (n.has(key)) n.delete(key);
        else n.add(key);
        return n;
      }),
    [],
  );

  const toggleSelect = useCallback(
    (key: string) =>
      setSelected((s) => {
        const n = new Set(s);
        if (n.has(key)) n.delete(key);
        else n.add(key);
        return n;
      }),
    [],
  );

  // Bulk actions
  const removeSelected = () => {
    onChange(
      value.filter((k) => !selected.has(k)),
      disabled.filter((k) => !selected.has(k)),
    );
    setSelected(new Set());
  };

  const disableSelected = () => {
    const toDisable = value.filter((k) => selected.has(k));
    onChange(
      value.filter((k) => !selected.has(k)),
      [...disabled, ...toDisable],
    );
    setSelected(new Set());
  };

  const enableSelected = () => {
    const toEnable = disabled.filter((k) => selected.has(k));
    onChange(
      [...value, ...toEnable],
      disabled.filter((k) => !selected.has(k)),
    );
    setSelected(new Set());
  };

  const selectFailed = () => {
    const failed = new Set<string>();
    for (const [key, result] of results) {
      if (!result.ok) failed.add(key);
    }
    setSelected(failed);
  };

  const allVisibleSelected =
    filteredRows.length > 0 && filteredRows.every((r) => selected.has(r.key));

  const toAdd = splitKeys(bulk).length;
  const hasResults = results.size > 0;
  const failedCount = [...results.values()].filter((r) => !r.ok).length;

  return (
    <div className="space-y-3">
      {/* Header badges */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-foreground">API keys</span>
        <Badge variant="secondary">{value.length} active</Badge>
        {disabled.length > 0 && (
          <Badge variant="secondary" className="opacity-70">
            {disabled.length} off
          </Badge>
        )}
        <span className="ml-auto text-[0.65rem] text-muted-foreground">
          Active keys rotate round-robin; disabled keys are skipped
        </span>
      </div>

      {/* Toolbar + list */}
      {allRows.length > 0 && (
        <div className="rounded-md border border-border">
          {/* Toolbar strip */}
          <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-2 py-1.5">
            <Checkbox
              checked={allVisibleSelected}
              onCheckedChange={(checked) =>
                setSelected(
                  checked ? new Set(filteredRows.map((r) => r.key)) : new Set(),
                )
              }
              aria-label="Select all"
            />

            {selected.size > 0 ? (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">
                  {selected.size} selected
                </span>
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={removeSelected}
                >
                  <Trash2 className="h-3 w-3" />
                  Remove
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={disableSelected}
                >
                  <PowerOff className="h-3 w-3" />
                  Disable
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={enableSelected}
                >
                  <Power className="h-3 w-3" />
                  Enable
                </Button>
              </div>
            ) : (
              hasResults &&
              failedCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={selectFailed}
                >
                  Select {failedCount} failed
                </Button>
              )
            )}

            <div className="ml-auto flex items-center gap-2">
              {allRows.length > 10 && (
                <TableSearch
                  value={filter}
                  onChange={setFilter}
                  placeholder="Filter keys…"
                  count={filter ? filteredRows.length : undefined}
                  total={filter ? allRows.length : undefined}
                  className="w-40"
                />
              )}
              {canTest && value.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => void testAll()}
                  disabled={testingAll}
                >
                  {testingAll ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <FlaskConical className="h-3 w-3" />
                  )}
                  Test all
                </Button>
              )}
            </div>
          </div>

          {/* Virtualized list */}
          <div ref={parentRef} className="max-h-80 overflow-y-auto">
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                position: "relative",
                width: "100%",
              }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = filteredRows[virtualRow.index];
                return (
                  <div
                    key={row.key}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <KeyRow
                      rowKey={row.key}
                      on={row.on}
                      isSelected={selected.has(row.key)}
                      revealed={revealed.has(row.key)}
                      testResult={results.get(row.key)}
                      isTesting={testing.has(row.key)}
                      showTest={canTest}
                      onSelect={toggleSelect}
                      onToggle={toggle}
                      onReveal={toggleReveal}
                      onTest={doTest}
                      onRemove={remove}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Bulk paste */}
      <div className="rounded-lg border border-dashed border-border p-2">
        <Textarea
          value={bulk}
          onChange={(e) => setBulk(e.target.value)}
          rows={2}
          placeholder={
            "Paste one or many keys — newline or comma separated\nsk-…, sk-…"
          }
          className="font-mono text-xs"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[0.65rem] text-muted-foreground">
            {toAdd > 0 ? `${toAdd} key(s) to add` : "Duplicates are skipped"}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={addBulk}
            disabled={toAdd === 0}
          >
            <Plus className="h-3.5 w-3.5" />
            Add keys
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- Memoized row ---

interface KeyRowProps {
  rowKey: string;
  on: boolean;
  isSelected: boolean;
  revealed: boolean;
  testResult: ProviderTestResult | undefined;
  isTesting: boolean;
  showTest: boolean;
  onSelect: (key: string) => void;
  onToggle: (key: string, on: boolean) => void;
  onReveal: (key: string) => void;
  onTest: (key: string) => void;
  onRemove: (key: string) => void;
}

const KeyRow = memo(function KeyRow({
  rowKey,
  on,
  isSelected,
  revealed,
  testResult,
  isTesting,
  showTest,
  onSelect,
  onToggle,
  onReveal,
  onTest,
  onRemove,
}: KeyRowProps) {
  return (
    <div
      className={cn(
        "flex h-8 items-center gap-1.5 border-b border-border px-2 last:border-b-0 hover:bg-muted/40",
        !on && "opacity-60",
        isSelected && "bg-primary/5",
      )}
    >
      <Checkbox
        checked={isSelected}
        onCheckedChange={() => onSelect(rowKey)}
        aria-label={`Select key ${mask(rowKey)}`}
      />

      <button
        type="button"
        title={on ? "Disable key" : "Enable key"}
        className={cn(
          "flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded transition-colors",
          on
            ? "bg-primary/80 text-primary-foreground hover:bg-primary/60"
            : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        )}
        onClick={() => onToggle(rowKey, on)}
      >
        <Check className="h-2.5 w-2.5" />
      </button>

      <span
        className={cn(
          "min-w-0 flex-1 truncate font-mono text-xs text-foreground",
          !on && "line-through",
        )}
      >
        {revealed ? rowKey : mask(rowKey)}
      </span>

      {testResult && (
        <Badge
          variant={testResult.ok ? "default" : "destructive"}
          className="h-4 px-1 text-[0.6rem]"
        >
          {testResult.ok ? `${testResult.ms}ms` : testResult.status || "err"}
        </Badge>
      )}

      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => onReveal(rowKey)}
          title={revealed ? "Hide" : "Reveal"}
          className="h-5 w-5 text-muted-foreground hover:text-foreground"
        >
          {revealed ? (
            <EyeOff className="h-2.5 w-2.5" />
          ) : (
            <Eye className="h-2.5 w-2.5" />
          )}
        </Button>

        {showTest && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => onTest(rowKey)}
                disabled={isTesting}
                title="Test this key"
                className="h-5 w-5 text-muted-foreground hover:text-foreground"
              >
                {isTesting ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                ) : (
                  <FlaskConical
                    className={cn(
                      "h-2.5 w-2.5",
                      testResult &&
                        (testResult.ok ? "text-success" : "text-destructive"),
                    )}
                  />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">
              {testResult
                ? testResult.ok
                  ? `Reachable · ${testResult.ms}ms`
                  : `Failed${testResult.status ? ` (${testResult.status})` : ""}${testResult.error ? ` — ${testResult.error}` : ""}`
                : "Send a test request with this key"}
            </TooltipContent>
          </Tooltip>
        )}

        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => onRemove(rowKey)}
          title="Remove key"
          className="h-5 w-5 text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-2.5 w-2.5" />
        </Button>
      </div>
    </div>
  );
});
