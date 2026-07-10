// Step 2: configure — name/baseUrl/keys from the template's fields, plus an
// Advanced disclosure for basePath/headers.

import { ChevronDown } from "lucide-react";
import type { ProviderTemplate } from "@/lib/types";
import { WIRE_KIND_LABELS } from "@/lib/types";
import { Field } from "@/components/shared";
import { ProviderIcon } from "@/components/model-icon";
import { Input } from "@/components/ui/input";
import { JsonEditor } from "@/components/json-editor";
import { KeyManager } from "@/components/key-manager";
import {
  cn,
  formatLabel,
  authSchemeLabel,
  conversionLabel,
  resolvedUrlPreview,
} from "@/lib/utils";

export function ConfigStep({
  tpl,
  name,
  setName,
  baseUrl,
  setBaseUrl,
  basePath,
  setBasePath,
  apiKeys,
  setApiKeys,
  showAdvanced,
  setShowAdvanced,
  headersText,
  setHeadersText,
}: {
  tpl: ProviderTemplate;
  name: string;
  setName: (v: string) => void;
  baseUrl: string;
  setBaseUrl: (v: string) => void;
  basePath: string;
  setBasePath: (v: string) => void;
  apiKeys: string[];
  setApiKeys: (v: string[]) => void;
  showAdvanced: boolean;
  setShowAdvanced: (v: boolean) => void;
  headersText: string;
  setHeadersText: (v: string) => void;
}) {
  const nameField = tpl.fields.find((f) => f.key === "name");
  const baseField = tpl.fields.find((f) => f.key === "baseUrl");
  const keyField = tpl.fields.find((f) => f.key === "apiKeys");
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-3">
        <ProviderIcon brand={tpl.brand} name={tpl.label} className="size-5" />
        <div className="min-w-0">
          <div className="text-sm font-medium">{tpl.label}</div>
          <div className="text-[0.7rem] text-muted-foreground">{tpl.blurb}</div>
        </div>
        {tpl.docsUrl && (
          <a
            href={tpl.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-[0.7rem] text-primary underline-offset-2 hover:underline"
          >
            Docs
          </a>
        )}
      </div>

      {nameField && (
        <Field label={nameField.label} hint={nameField.hint}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={nameField.placeholder}
          />
        </Field>
      )}

      {baseField && (
        <Field label={baseField.label} hint={baseField.hint}>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={baseField.placeholder ?? tpl.defaults.baseUrl}
            className="font-mono"
            disabled={baseField.editable === false}
          />
        </Field>
      )}

      {keyField && (
        <KeyManager value={apiKeys} onChange={(en) => setApiKeys(en)} />
      )}

      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              showAdvanced && "rotate-180",
            )}
          />
          Advanced
        </button>
        {showAdvanced && (
          <div className="mt-3 space-y-3 rounded-lg border border-border bg-card p-3">
            <div className="grid grid-cols-2 gap-3 text-[0.7rem]">
              {tpl.defaults.format && (
                <Meta
                  label="Wire format"
                  value={formatLabel(tpl.defaults.format)}
                />
              )}
              <Meta
                label="Auth scheme"
                value={authSchemeLabel(tpl.defaults.authScheme ?? "bearer")}
              />
              <Meta
                label="Endpoints"
                value={
                  (tpl.defaults.endpoints ?? [])
                    .map((k) => WIRE_KIND_LABELS[k])
                    .join(", ") || "—"
                }
              />
              <Meta
                label="Conversion"
                value={conversionLabel(tpl.defaults.nativeConversion ?? false)}
              />
            </div>
            <Field
              label="Base path"
              hint="Inserted between origin and endpoint — REPLACES the implicit /v1 prefix (blank = /v1 is used). Include it yourself if you need it, e.g. /v1beta/openai."
            >
              <Input
                value={basePath}
                onChange={(e) => setBasePath(e.target.value)}
                placeholder="blank = /v1"
                className="font-mono"
              />
            </Field>
            <div>
              <div className="mb-1.5 text-xs font-medium text-foreground">
                Resolved URL
              </div>
              <div className="break-all rounded-md border border-border bg-muted/30 px-3 py-1.5 font-mono text-[0.7rem] text-muted-foreground">
                {resolvedUrlPreview(
                  baseUrl,
                  basePath,
                  tpl.defaults.endpoints?.[0],
                  tpl.defaults.endpointPaths,
                ) || "—"}
              </div>
            </div>
            <Field
              label="Extra headers"
              hint="JSON merged onto every upstream request"
            >
              <JsonEditor
                value={headersText}
                onChange={setHeadersText}
                placeholder='{ "anthropic-version": "2023-06-01" }'
              />
            </Field>
            <p className="text-[0.65rem] text-muted-foreground">
              Fine-tune retries, timeouts and endpoints after creating the
              provider from its detail view.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="font-mono text-foreground">{value}</div>
    </div>
  );
}
