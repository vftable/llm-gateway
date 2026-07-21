import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type { Settings as SettingsT } from "@/lib/types";
import {
  PageSkeleton,
  Field,
  FormSection,
  SettingRow,
} from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn, fmtNum } from "@/lib/utils";

const SECTIONS = [
  { id: "models", label: "Models" },
  { id: "limits", label: "Runtime" },
  { id: "webtools", label: "Integrations" },
  { id: "maintenance", label: "Maintenance" },
  { id: "password", label: "Access" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export default function Settings() {
  const [s, setS] = useState<SettingsT | null>(null);
  const [exempt, setExempt] = useState("");
  const [saving, setSaving] = useState(false);
  const [active, setActive] = useState<SectionId>("models");

  const [pw, setPw] = useState("");
  const [pwSaving, setPwSaving] = useState(false);

  const [busy, setBusy] = useState<string | null>(null);

  const rebuildUsage = async () => {
    setBusy("rebuild");
    try {
      const r = await api.rebuildUsage();
      toast.success(
        `Usage rebuilt from logs — ${fmtNum(r.tokens)} tokens across ${r.days} day${r.days === 1 ? "" : "s"}`,
      );
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const clearLogs = async (scope: "errors" | "all") => {
    const label = scope === "all" ? "ALL request logs" : "failed request logs";
    if (!confirm(`Delete ${label}? This cannot be undone.`)) return;
    setBusy(scope);
    try {
      const r = await api.clearLogs(scope);
      toast.success(
        `Removed ${fmtNum(r.removed)} log row${r.removed === 1 ? "" : "s"}`,
      );
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const clearRateLimits = async () => {
    if (
      !confirm(
        "Clear all provider rate-limit cooldowns and cached quota snapshots? Auth-failed keys remain disabled.",
      )
    )
      return;
    setBusy("rate-limits");
    try {
      const r = await api.clearRateLimits();
      toast.success(
        `Cleared ${fmtNum(r.keysCleared)} key cooldown${r.keysCleared === 1 ? "" : "s"}, ${fmtNum(r.modelCooldownsCleared)} model cooldown${r.modelCooldownsCleared === 1 ? "" : "s"}, and ${fmtNum(r.unifiedUsageCleared)} quota snapshot${r.unifiedUsageCleared === 1 ? "" : "s"}`,
      );
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    api
      .getSettings()
      .then((data) => {
        setS(data);
        setExempt((data.exposeExempt || []).join(", "));
      })
      .catch(toast.error);
  }, []);

  if (!s) return <PageSkeleton tabs={SECTIONS.length} />;

  const set = <K extends keyof SettingsT>(k: K, v: SettingsT[K]) =>
    setS((prev) => (prev ? { ...prev, [k]: v } : prev));

  const save = async () => {
    setSaving(true);
    try {
      const {
        bootstrap: _bootstrap,
        webProviders: _webProviders,
        ...editable
      } = s;
      await api.updateSettings({
        ...editable,
        exposeExempt: exempt
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      });
      toast.success("Settings saved");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const changePw = async () => {
    if (pw.length < 4) {
      toast.error("Password must be at least 4 characters");
      return;
    }
    setPwSaving(true);
    try {
      await api.changePassword(pw);
      toast.success("Admin password changed");
      setPw("");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setPwSaving(false);
    }
  };

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Settings
          </h1>
          <p className="mt-1 text-xs font-medium text-muted-foreground">
            Global gateway configuration
          </p>
        </div>
        <Button onClick={save} disabled={saving}>
          <Check className="h-3.5 w-3.5" />
          {saving ? "Saving\u2026" : "Save Settings"}
        </Button>
      </div>

      <div className="flex flex-col gap-6">
        <div className="flex gap-1 border-b border-border/60">
          {SECTIONS.map((sec) => (
            <button
              key={sec.id}
              type="button"
              onClick={() => setActive(sec.id)}
              className={cn(
                "relative cursor-pointer px-3 py-2 text-sm font-medium transition-colors",
                active === sec.id
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {sec.label}
              {active === sec.id && (
                <span className="absolute right-0 bottom-0 left-0 h-0.5 rounded-full bg-primary" />
              )}
            </button>
          ))}
        </div>

        {active === "models" && (
          <div className="max-w-3xl">
            <FormSection
              title="Model Exposure"
              desc="Controls what alias clients see and which models are allowed through."
            >
              <SettingRow
                label="Global model prefix"
                hint="Prepended to every exposed ID"
              >
                <Input
                  value={s.modelPrefix}
                  onChange={(e) => set("modelPrefix", e.target.value)}
                />
              </SettingRow>
              <SettingRow
                label="Expose prefix"
                hint="Prepended unless alias starts with an exempt prefix"
              >
                <Input
                  value={s.exposePrefix}
                  onChange={(e) => set("exposePrefix", e.target.value)}
                />
              </SettingRow>
              <SettingRow
                label="Expose-exempt prefixes"
                hint="Comma-separated, e.g. claude"
              >
                <Input
                  value={exempt}
                  onChange={(e) => setExempt(e.target.value)}
                />
              </SettingRow>
              <SettingRow
                label="Allow unknown models"
                hint="Let requests for un-configured aliases pass through as-is."
              >
                <div className="sm:flex sm:justify-end">
                  <Switch
                    checked={s.allowUnknown}
                    onCheckedChange={(v) => set("allowUnknown", v)}
                  />
                </div>
              </SettingRow>
            </FormSection>
          </div>
        )}

        {active === "limits" && (
          <div className="max-w-3xl">
            <FormSection
              title="Limits & Timeouts"
              desc="Defaults applied across every model and provider unless overridden."
            >
              <SettingRow label="Default max output tokens">
                <Input
                  type="number"
                  value={s.defaultMaxOutputTokens}
                  onChange={(e) =>
                    set("defaultMaxOutputTokens", Number(e.target.value))
                  }
                />
              </SettingRow>
              <SettingRow
                label="Generic SSE keepalive (ms)"
                hint="OpenAI-compatible streams only; 0 disables. Anthropic Messages always emits protocol-native ping events every 15 seconds."
              >
                <Input
                  type="number"
                  value={s.ssePingInterval}
                  onChange={(e) =>
                    set("ssePingInterval", Number(e.target.value))
                  }
                />
              </SettingRow>
              <SettingRow label="Request log retention (days)">
                <Input
                  type="number"
                  value={s.requestLogRetentionDays}
                  onChange={(e) =>
                    set("requestLogRetentionDays", Number(e.target.value))
                  }
                />
              </SettingRow>
              <SettingRow
                label="Debug request logging"
                hint="Capture the distilled request (messages, tools) and response (text, tool calls) into each log row, and print every transform stage (builtin/family/adapter/model, request+response+stream) to the backend console as it runs — for both live traffic and the Imported Models 'Test' probe. Adds storage per request and console noise; leave off in normal operation."
              >
                <div className="sm:flex sm:justify-end">
                  <Switch
                    checked={s.debugLogging}
                    onCheckedChange={(v) => set("debugLogging", v)}
                  />
                </div>
              </SettingRow>
            </FormSection>
          </div>
        )}

        {active === "webtools" && (
          <div className="max-w-3xl">
            <FormSection title="Web Tools">
              <SettingRow
                label="Back web_search / web_fetch with a web provider"
                hint={
                  <>
                    When a client requests Anthropic&apos;s hosted{" "}
                    <code className="text-primary">web_search</code> /{" "}
                    <code className="text-primary">web_fetch</code> tools, the
                    gateway runs the tool loop itself against the selected
                    provider — so search works against any upstream model, no
                    Anthropic dependency. Requests that search are answered
                    non-streaming while tools run, then delivered (streamed if
                    requested).
                  </>
                }
              >
                <div className="sm:flex sm:justify-end">
                  <Switch
                    checked={s.webToolsEnabled}
                    onCheckedChange={(v) => set("webToolsEnabled", v)}
                  />
                </div>
              </SettingRow>
              <SettingRow
                label="Provider"
                hint="Which backend runs the searches."
              >
                <Select
                  value={s.webToolsProvider}
                  onValueChange={(v) => set("webToolsProvider", v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {(s.webProviders ?? [s.webToolsProvider]).map((p) => (
                      <SelectItem key={p} value={p} className="capitalize">
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>
              <SettingRow
                label="Provider base URL"
                hint="blank = the provider's default endpoint"
              >
                <Input
                  value={s.webProviderBaseUrl}
                  onChange={(e) => set("webProviderBaseUrl", e.target.value)}
                  placeholder="(default)"
                />
              </SettingRow>
              <SettingRow
                label="Provider API key"
                hint="blank = keyless where the provider supports it"
              >
                <Input
                  value={s.webProviderApiKey}
                  onChange={(e) => set("webProviderApiKey", e.target.value)}
                  placeholder="(optional)"
                />
              </SettingRow>
            </FormSection>
          </div>
        )}

        {active === "maintenance" && (
          <div className="rounded-lg border border-border bg-card p-5">
            <h2 className="font-heading text-lg font-medium text-foreground mb-4">
              Data Maintenance
            </h2>
            <div className="flex flex-col divide-y divide-border/60">
              <div className="flex items-center justify-between gap-4 pb-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">
                    Rebuild usage counters
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    Recompute the usage totals and per-provider breakdown from
                    the request log (the actual per-request record). Fixes any
                    drift so the Overview, Usage and Resolution views all agree.
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={rebuildUsage}
                  disabled={busy !== null}
                  className="shrink-0"
                >
                  {busy === "rebuild" ? "Rebuilding…" : "Rebuild"}
                </Button>
              </div>

              <div className="flex items-center justify-between gap-4 py-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">
                    Clear all rate limits
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    Make globally rate-limited keys and Fable/Mythos-scoped keys
                    immediately eligible again, and discard cached upstream
                    quota snapshots. Auth-failed keys stay disabled and must be
                    handled from the Provider Keys page.
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={clearRateLimits}
                  disabled={busy !== null}
                  className="shrink-0"
                >
                  {busy === "rate-limits" ? "Clearing…" : "Clear limits"}
                </Button>
              </div>

              <div className="flex items-center justify-between gap-4 py-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">
                    Clear failed request logs
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    Delete only rows that errored (status 4xx/5xx or no
                    response), trimming noise from the log feed. Token counters
                    are unaffected.
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => clearLogs("errors")}
                  disabled={busy !== null}
                  className="shrink-0"
                >
                  {busy === "errors" ? "Clearing…" : "Clear errors"}
                </Button>
              </div>

              <div className="flex items-center justify-between gap-4 pt-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">
                    Clear all request logs
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    Wipe the entire request log. Historical usage counters stay
                    intact, but a subsequent rebuild will have nothing to draw
                    from. Use sparingly.
                  </p>
                </div>
                <Button
                  variant="destructive"
                  onClick={() => clearLogs("all")}
                  disabled={busy !== null}
                  className="shrink-0"
                >
                  {busy === "all" ? "Clearing…" : "Clear all"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {active === "password" && (
          <div className="max-w-3xl space-y-5">
            <FormSection
              title="Gateway Access"
              desc="Authentication behavior applied immediately to new requests."
            >
              <SettingRow
                label="Disabled API key message"
                hint="Returned to a client whose known gateway API key is disabled or revoked."
              >
                <Textarea
                  value={s.disabledApiKeyMessage}
                  onChange={(e) =>
                    set("disabledApiKeyMessage", e.target.value.slice(0, 2000))
                  }
                  rows={3}
                  maxLength={2000}
                />
              </SettingRow>
            </FormSection>

            <div className="rounded-lg border border-border bg-card p-5">
              <h2 className="mb-4 font-heading text-lg font-medium text-foreground">
                Admin Password
              </h2>
              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <Field label="New password">
                    <Input
                      type="password"
                      value={pw}
                      onChange={(e) => setPw(e.target.value)}
                      placeholder="New password"
                    />
                  </Field>
                </div>
                <Button onClick={changePw} disabled={pwSaving || !pw}>
                  {pwSaving ? "Updating\u2026" : "Update Password"}
                </Button>
              </div>
            </div>

            {s.bootstrap && (
              <FormSection
                title="Server Configuration"
                desc="Read from config.json at process start. Edit the file and restart the gateway to change these values."
              >
                {[
                  ["Port", String(s.bootstrap.port)],
                  ["Data directory", s.bootstrap.dataDir],
                  ["Database path", s.bootstrap.dbPath],
                  ["Web build directory", s.bootstrap.webDistDir],
                  ["Admin session TTL", `${s.bootstrap.sessionTtlHours} hours`],
                  ["CORS origin", s.bootstrap.corsOrigin || "\u2014"],
                  ["Config file", s.bootstrap.configPath || "\u2014"],
                ].map(([label, value]) => (
                  <SettingRow key={label} label={label}>
                    <span
                      className="block min-w-0 truncate text-right font-mono text-xs text-muted-foreground"
                      title={value}
                    >
                      {value}
                    </span>
                  </SettingRow>
                ))}
              </FormSection>
            )}

            <Separator />
            <p className="text-xs leading-relaxed text-muted-foreground">
              The gateway listens on{" "}
              <code className="font-medium text-primary">/v1/*</code> for LLM
              traffic and{" "}
              <code className="font-medium text-primary">/api/*</code> for this
              dashboard. Provider credentials and client API keys are managed
              from their dedicated pages and are intentionally omitted here.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
