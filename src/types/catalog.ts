// Provider catalog (stock provider registry) types.
//
// Declarative presets that pre-fill a new provider's config so users don't have
// to hand-type base URLs, wire formats, auth schemes and version headers. Purely
// additive: a template produces a normal Provider row — the proxy engine never
// sees the template. See src/providers/.

import type { AuthScheme, ProviderFormat } from "./provider";
import type { ModelCapabilities } from "./capabilities";

// Which Provider fields a template pre-fills. A subset of ProviderInput's config
// knobs (identity/keys are supplied by the user in the wizard).
export interface ProviderDefaults {
  baseUrl?: string;
  basePath?: string;
  modelsPath?: string;
  format?: ProviderFormat;
  endpoints?: string[];
  authScheme?: AuthScheme;
  extraHeaders?: Record<string, string>;
  nativeConversion?: boolean;
  retryAttempts?: number;
  retryIntervalMs?: number;
  requestTimeoutMs?: number;
  tlsVerify?: boolean;
  proxy?: string | null;
  country?: string | null;
}

// Known behaviors a stock provider needs. Applied at provider-create / model-import
// time only — NOT on the request hot path — so adding a quirk can never regress
// streaming or format conversion.
export interface ProviderQuirks {
  /** Headers merged into the provider's extraHeaders on create (e.g. anthropic-version). */
  requiredHeaders?: Record<string, string>;
  /** Hints that seed a model's thinking capability when imported from this provider. */
  thinking?: {
    defaultType?: "adaptive" | "enabled";
    supportsEffort?: boolean;
  };
  /** Capability overrides merged onto DEFAULT_CAPABILITIES for imported models. */
  defaultCapabilities?: Partial<ModelCapabilities>;
}

// One field the Add-Provider wizard should surface for a template. `key` maps to
// a ProviderInput field; `required` gates the Next button.
export interface TemplateField {
  key: "name" | "apiKeys" | "baseUrl";
  label: string;
  placeholder?: string;
  required?: boolean;
  /** For baseUrl: whether the user may change the template default. */
  editable?: boolean;
  hint?: string;
}

export interface ProviderTemplate {
  id: string;
  label: string;
  blurb: string;
  /** Brand key resolved by the web brand-icon catalog (falls back to a chip). */
  brand: string;
  defaults: ProviderDefaults;
  fields: TemplateField[];
  quirks?: ProviderQuirks;
  docsUrl?: string;
}
