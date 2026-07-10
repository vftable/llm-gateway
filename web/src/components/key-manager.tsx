// Bulk API-key manager. Controlled: the parent owns the enabled + disabled
// string[] arrays.
//
// Replaces the raw one-key-per-line textarea with a proper manager: each key is
// a masked row (enable toggle + reveal + test + remove), and a bulk-paste box
// accepts many keys at once (newline- OR comma-separated), de-duplicating
// against every key already present. A key toggled off moves to the disabled
// set — retained, but skipped in rotation. Emits both arrays; the parent
// persists them via PUT /providers/:id.
//
// Per-key test (only when `providerId` is given — a not-yet-saved provider in
// the Add-Provider wizard has no id to test against): each row gets a
// FlaskConical button that sends THAT EXACT key through POST
// /providers/:id/test (bypassing the live rotation pick), same probe as the
// provider-level "Test connection" button, just pinned to one key. "Test all"
// runs every enabled key's probe sequentially (one request in flight at a
// time — a burst of parallel probes against the same provider isn't
// necessary and could trip upstream rate limits).

import { useState } from "react";
import {
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Check,
  FlaskConical,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import type { ProviderTestResult } from "@/lib/types";
import { toast } from "sonner";

// Split a bulk paste into individual keys (newline or comma separated), trimmed
// and non-empty.
function splitKeys(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((k) => k.trim())
    .filter(Boolean);
}

// Mask a key for display: keep a short head + tail, hide the middle.
function mask(key: string): string {
  if (key.length <= 10) return key.slice(0, 2) + "…";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function KeyManager({
  value,
  disabled = [],
  onChange,
  providerId,
}: {
  value: string[];
  disabled?: string[];
  onChange: (enabled: string[], disabled: string[]) => void;
  /** When given, each row gets a per-key Test button + a "Test all" action.
   *  Omitted in the Add-Provider wizard, where the provider isn't saved yet. */
  providerId?: string;
}) {
  const [bulk, setBulk] = useState("");
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Map<string, ProviderTestResult>>(
    new Map(),
  );
  const [testingAll, setTestingAll] = useState(false);

  // One flat, ordered view: enabled first, then disabled. Each carries its `on`
  // flag so a single map renders the whole list.
  const rows = [
    ...value.map((k) => ({ key: k, on: true })),
    ...disabled.map((k) => ({ key: k, on: false })),
  ];
  const total = rows.length;

  const testKey = async (key: string) => {
    if (!providerId) return;
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
  };

  const testAll = async () => {
    if (!providerId || value.length === 0) return;
    setTestingAll(true);
    let okCount = 0;
    try {
      for (const key of value) {
        const r = await testKey(key);
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

  const remove = (key: string) => {
    onChange(
      value.filter((k) => k !== key),
      disabled.filter((k) => k !== key),
    );
  };

  const toggle = (key: string, on: boolean) => {
    if (on) {
      // enabled -> disabled
      onChange(
        value.filter((k) => k !== key),
        [...disabled, key],
      );
    } else {
      // disabled -> enabled
      onChange(
        [...value, key],
        disabled.filter((k) => k !== key),
      );
    }
  };

  const toggleReveal = (key: string) =>
    setRevealed((r) => {
      const n = new Set(r);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const toAdd = splitKeys(bulk).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground">
          API keys
          <Badge variant="secondary" className="ml-2">
            {value.length} active
          </Badge>
          {disabled.length > 0 && (
            <Badge variant="secondary" className="ml-1.5 opacity-70">
              {disabled.length} off
            </Badge>
          )}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[0.65rem] text-muted-foreground">
            Active keys rotate round-robin; disabled keys are skipped
          </span>
          {providerId && value.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void testAll()}
              disabled={testingAll}
            >
              {testingAll ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FlaskConical className="h-3.5 w-3.5" />
              )}
              Test all
            </Button>
          )}
        </div>
      </div>

      {total > 0 && (
        <div className="space-y-1">
          {rows.map(({ key, on }) => (
            <div
              key={key}
              className={cn(
                "flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5",
                !on && "opacity-60",
              )}
            >
              <button
                type="button"
                title={on ? "Disable key" : "Enable key"}
                className={cn(
                  // Matches Button size="icon-xs" (h-6 w-6, rounded-md) exactly —
                  // this is the one row-leading control that isn't a <Button>
                  // (it needs the on/off two-tone fill, not a variant), so its
                  // box must track the shared size manually to stay flush with
                  // the reveal/test/remove icon buttons beside it.
                  "flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors",
                  on
                    ? "bg-primary/80 text-primary-foreground hover:bg-primary/60"
                    : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
                onClick={() => toggle(key, on)}
              >
                <Check className="h-3 w-3" />
              </button>
              <span
                className={cn(
                  "flex-1 truncate font-mono text-xs text-foreground",
                  !on && "line-through",
                )}
              >
                {revealed.has(key) ? key : mask(key)}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => toggleReveal(key)}
                title={revealed.has(key) ? "Hide" : "Reveal"}
              >
                {revealed.has(key) ? (
                  <EyeOff className="h-3 w-3" />
                ) : (
                  <Eye className="h-3 w-3" />
                )}
              </Button>
              {providerId && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => void testKey(key)}
                      disabled={testing.has(key)}
                      title="Test this key"
                    >
                      {testing.has(key) ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <FlaskConical
                          className={cn(
                            "h-3 w-3",
                            results.get(key) &&
                              (results.get(key)!.ok
                                ? "text-success"
                                : "text-destructive"),
                          )}
                        />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-64">
                    {results.has(key)
                      ? results.get(key)!.ok
                        ? `Reachable · ${results.get(key)!.ms}ms`
                        : `Failed${results.get(key)!.status ? ` (${results.get(key)!.status})` : ""}${results.get(key)!.error ? ` — ${results.get(key)!.error}` : ""}`
                      : "Send a test request with this key"}
                  </TooltipContent>
                </Tooltip>
              )}
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => remove(key)}
                title="Remove key"
              >
                <Trash2 className="h-3 w-3 text-destructive" />
              </Button>
            </div>
          ))}
        </div>
      )}

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
