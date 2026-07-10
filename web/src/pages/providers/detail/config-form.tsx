// Config tab (identity/wire-format) and Advanced tab (connection/reliability/
// headers/proxy/region) — both driven by the same ConfigForm, split by
// `section`.

import { useState } from "react";
import { FlaskConical, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type {
  Provider,
  ProviderInput,
  ProviderTestInput,
  WireKind,
} from "@/lib/types";
import { WIRE_KINDS, WIRE_KIND_LABELS } from "@/lib/types";
import { FormSection, SettingRow } from "@/components/shared";
import { CountryFlag, COUNTRIES } from "@/components/country-flag";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { JsonEditor } from "@/components/json-editor";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  authSchemeLabel,
  conversionHelp,
  resolvedUrlPreview,
  endpointPathPreview,
  hostFromUrl,
} from "@/lib/utils";

const SCHEMES = ["bearer", "xapikey", "both", "passthrough"] as const;

export function ConfigForm({
  provider,
  onSaved,
  section,
}: {
  provider: Provider;
  onSaved: () => void;
  section: "config" | "advanced";
}) {
  const [form, setForm] = useState<ProviderInput>(() => ({
    name: provider.name,
    baseUrl: provider.baseUrl,
    host: provider.host ?? "",
    authScheme: provider.authScheme,
    apiKeys: provider.apiKeys,
    retryAttempts: provider.retryAttempts,
    retryIntervalMs: provider.retryIntervalMs,
    requestTimeoutMs: provider.requestTimeoutMs,
    tlsVerify: provider.tlsVerify,
    enabled: provider.enabled,
    extraHeaders: provider.extraHeaders,
    format: provider.format,
    endpoints: provider.endpoints,
    nativeConversion: provider.nativeConversion,
    catalogId: provider.catalogId,
    basePath: provider.basePath,
    modelsPath: provider.modelsPath,
    proxy: provider.proxy,
    country: provider.country,
  }));
  const [headersText, setHeadersText] = useState(
    JSON.stringify(provider.extraHeaders ?? {}, null, 2),
  );
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof ProviderInput>(k: K, v: ProviderInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  // Toggle a wire kind on/off in the accepted set (order kept stable).
  const toggleEndpoint = (kind: WireKind) =>
    setForm((f) => {
      const have = f.endpoints ?? [];
      const next = have.includes(kind)
        ? have.filter((k) => k !== kind)
        : WIRE_KINDS.filter((k) => have.includes(k) || k === kind);
      return { ...f, endpoints: next };
    });

  const previewUrl = resolvedUrlPreview(
    form.baseUrl,
    form.basePath,
    (form.endpoints ?? [])[0],
    form.endpointPaths,
  );

  const save = async () => {
    setSaving(true);
    let extraHeaders: Record<string, string> = {};
    try {
      extraHeaders = headersText.trim() ? JSON.parse(headersText) : {};
    } catch {
      toast.error("Extra headers must be valid JSON");
      setSaving(false);
      return;
    }
    try {
      // Keys are managed on the Keys tab — omit them here so a config save can't
      // clobber a key edit (updateProvider merges: undefined keeps existing).
      const { apiKeys, ...rest } = form;
      void apiKeys;
      await api.updateProvider(provider.id, { ...rest, extraHeaders });
      toast.success("Provider updated");
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const SaveBar = (
    <div className="sticky bottom-0 -mx-1 flex justify-end border-t border-border/60 bg-background/80 px-1 py-3 backdrop-blur">
      <Button onClick={save} disabled={saving || !form.name || !form.baseUrl}>
        {saving ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Check className="h-3.5 w-3.5" />
        )}
        {saving ? "Saving…" : "Save changes"}
      </Button>
    </div>
  );

  if (section === "config") {
    return (
      <div className="max-w-3xl space-y-6">
        <FormSection title="Identity">
          <SettingRow label="Name" hint="Shown across the dashboard.">
            <Input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </SettingRow>
          <SettingRow label="Base URL" hint="Origin the gateway forwards to.">
            <Input
              value={form.baseUrl}
              onChange={(e) => set("baseUrl", e.target.value)}
              className="font-mono"
            />
          </SettingRow>
          <SettingRow
            label="Enabled"
            hint="Disabled providers are skipped in every chain."
          >
            <div className="sm:flex sm:justify-end">
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => set("enabled", v)}
              />
            </div>
          </SettingRow>
        </FormSection>

        <FormSection
          title="Wire format & routing"
          desc="How the gateway addresses this provider and whether it converts."
        >
          <SettingRow
            label="Conversion policy"
            hint={conversionHelp(form.nativeConversion ?? false)}
          >
            <Select
              value={form.nativeConversion ? "native" : "gateway"}
              onValueChange={(v) => set("nativeConversion", v === "native")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="gateway">Gateway converts</SelectItem>
                <SelectItem value="native">
                  Provider converts (accepts all three)
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>

          {form.nativeConversion && (
            <SettingRow
              label="Accepted formats"
              hint="Pick which the gateway sends per chain hop in the model editor; the provider converts the rest."
            >
              <div className="flex flex-wrap gap-1.5 text-xs sm:justify-end">
                {WIRE_KINDS.map((kind) => (
                  <span
                    key={kind}
                    className="rounded-md border border-border bg-muted/40 px-2 py-1 text-foreground"
                  >
                    {WIRE_KIND_LABELS[kind]}
                  </span>
                ))}
              </div>
            </SettingRow>
          )}

          <SettingRow
            label="Base path"
            hint={
              <>
                Inserted between origin and endpoint —{" "}
                <span className="font-mono">
                  origin + basePath + /chat/completions
                </span>
                . REPLACES the implicit <span className="font-mono">/v1</span>{" "}
                prefix (blank = <span className="font-mono">/v1</span> is used);
                include it yourself if you need it, e.g.{" "}
                <span className="font-mono">/v1beta/openai</span>.
              </>
            }
          >
            <Input
              value={form.basePath ?? ""}
              onChange={(e) => set("basePath", e.target.value)}
              placeholder="blank = /v1"
              className="font-mono"
            />
          </SettingRow>
          <SettingRow
            label="Models path"
            hint="For discovery / test — joined onto origin + base path."
          >
            <Input
              value={form.modelsPath ?? ""}
              onChange={(e) => set("modelsPath", e.target.value)}
              placeholder="/v1/models"
              className="font-mono"
            />
          </SettingRow>
          <SettingRow
            label="Accepted endpoints"
            hint="Which endpoint kinds this provider accepts. The adapter builds the path from base URL + base path; the model editor pins one per chain hop."
          >
            <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
              {WIRE_KINDS.map((kind) => {
                const on = (form.endpoints ?? []).includes(kind);
                return (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => toggleEndpoint(kind)}
                    className={
                      "rounded-md border px-2.5 py-1 text-xs transition-colors " +
                      (on
                        ? "cursor-pointer border-primary bg-primary/10 text-primary"
                        : "cursor-pointer border-border text-muted-foreground hover:border-primary/50 hover:text-foreground")
                    }
                    title={endpointPathPreview(
                      kind,
                      form.basePath,
                      form.endpointPaths,
                    )}
                  >
                    {WIRE_KIND_LABELS[kind]}
                  </button>
                );
              })}
            </div>
          </SettingRow>
          <SettingRow
            label="Upstream URL"
            hint="The composed URL the first endpoint resolves to."
          >
            <div className="break-all rounded-md border border-border bg-muted/30 px-3 py-1.5 font-mono text-xs text-foreground">
              {previewUrl || "—"}
            </div>
          </SettingRow>
        </FormSection>

        {SaveBar}
      </div>
    );
  }

  // advanced section
  return (
    <div className="max-w-3xl space-y-6">
      <FormSection title="Connection">
        <SettingRow
          label="Host header override"
          hint="Blank = derive from the base URL."
        >
          <Input
            value={form.host ?? ""}
            onChange={(e) => set("host", e.target.value || null)}
            placeholder={hostFromUrl(form.baseUrl)}
            className="font-mono"
          />
        </SettingRow>
        <SettingRow
          label="Auth scheme"
          hint="How the key is attached upstream."
        >
          <Select
            value={form.authScheme}
            onValueChange={(v) =>
              set("authScheme", v as ProviderInput["authScheme"])
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCHEMES.map((s) => (
                <SelectItem key={s} value={s}>
                  {authSchemeLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          label="TLS verification"
          hint="Turn off only for self-signed local upstreams."
        >
          <div className="sm:flex sm:justify-end">
            <Switch
              checked={form.tlsVerify}
              onCheckedChange={(v) => set("tlsVerify", v)}
            />
          </div>
        </SettingRow>
      </FormSection>

      <FormSection
        title="Reliability"
        desc="Retry + timeout behavior for every request to this provider."
      >
        <SettingRow
          label="Retry attempts"
          hint="Per request, before failing over."
        >
          <Input
            type="number"
            min={1}
            value={form.retryAttempts}
            onChange={(e) => set("retryAttempts", Number(e.target.value))}
            className="sm:max-w-40"
          />
        </SettingRow>
        <SettingRow label="Retry interval" hint="Milliseconds between retries.">
          <Input
            type="number"
            min={0}
            value={form.retryIntervalMs}
            onChange={(e) => set("retryIntervalMs", Number(e.target.value))}
            className="sm:max-w-40"
          />
        </SettingRow>
        <SettingRow
          label="Timeout"
          hint="Milliseconds before a request is aborted."
        >
          <Input
            type="number"
            min={1000}
            value={form.requestTimeoutMs}
            onChange={(e) => set("requestTimeoutMs", Number(e.target.value))}
            className="sm:max-w-40"
          />
        </SettingRow>
      </FormSection>

      <FormSection title="Headers, proxy & region">
        <SettingRow
          label="Extra upstream headers"
          hint="JSON object — merged onto every request."
        >
          <JsonEditor
            value={headersText}
            onChange={setHeadersText}
            placeholder={'{ "anthropic-version": "2023-06-01" }'}
          />
        </SettingRow>
        <SettingRow
          label="Outbound proxy"
          hint={
            <>
              <span className="font-mono">socks5://host:port</span> or{" "}
              <span className="font-mono">http://host:port</span> — blank =
              direct.
            </>
          }
        >
          <ProxyField
            value={form.proxy ?? ""}
            onChange={(v) => set("proxy", v || null)}
            testConfig={() => ({
              baseUrl: form.baseUrl,
              apiKey: (form.apiKeys ?? [])[0],
              authScheme: form.authScheme,
              basePath: form.basePath,
              modelsPath: form.modelsPath,
              proxy: form.proxy || null,
            })}
          />
        </SettingRow>
        <SettingRow
          label="Country"
          hint="Egress region tag (flag shown in the UI)."
        >
          <CountryPicker
            value={form.country ?? ""}
            onChange={(v) => set("country", v || null)}
          />
        </SettingRow>
      </FormSection>

      {SaveBar}
    </div>
  );
}

function ProxyField({
  value,
  onChange,
  testConfig,
}: {
  value: string;
  onChange: (v: string) => void;
  testConfig: () => ProviderTestInput;
}) {
  const [testing, setTesting] = useState(false);
  const [ok, setOk] = useState<boolean | null>(null);
  const test = async () => {
    setTesting(true);
    setOk(null);
    try {
      const r = await api.testProviderConfig(testConfig());
      setOk(r.ok);
      if (r.ok) toast.success(`Reachable via proxy (${r.ms}ms)`);
      else toast.error(r.error || `status ${r.status}`);
    } catch (e) {
      setOk(false);
      toast.error((e as Error).message);
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="flex gap-2">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="socks5://127.0.0.1:1080"
        className="font-mono"
      />
      <Button variant="outline" size="sm" onClick={test} disabled={testing}>
        {testing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : ok === true ? (
          <Check className="h-3.5 w-3.5 text-success" />
        ) : (
          <FlaskConical className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  );
}

function CountryPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <CountryFlag code={value} />
      <Select
        value={value || "none"}
        onValueChange={(v) => onChange(v === "none" ? "" : v)}
      >
        <SelectTrigger aria-label="Egress country">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">— none —</SelectItem>
          {COUNTRIES.map((c) => (
            <SelectItem key={c.code} value={c.code}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
