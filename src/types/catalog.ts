// Provider catalog (stock provider registry) types.
//
// Declarative presets that pre-fill a new provider's config so users don't have
// to hand-type base URLs, wire formats, auth schemes and version headers. Purely
// additive: a template produces a normal Provider row — the proxy engine never
// sees the template. See src/providers/.

import type { AuthScheme, ProviderFormat, WireKind } from "./provider";
import type { ModelCapabilities } from "./capabilities";
import type { ModelTransformConfig } from "./transforms";

// Which Provider fields a template pre-fills. A subset of ProviderInput's config
// knobs (identity/keys are supplied by the user in the wizard).
export interface ProviderDefaults {
  baseUrl?: string;
  basePath?: string;
  modelsPath?: string;
  /** Generic-adapter hint; omitted for adapter-backed templates (derived). */
  format?: ProviderFormat;
  /** Endpoint KINDS the provider accepts (chat/messages/responses). */
  endpoints?: WireKind[];
  /** Optional per-kind path override for a non-standard layout (rarely needed). */
  endpointPaths?: Partial<Record<WireKind, string>>;
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
  /**
   * Default per-model transforms for this provider family. Applied two ways:
   *   1. Seeded (editable) onto a provider-model's transforms when it is first
   *      imported and none were supplied.
   *   2. Applied as an always-on BASE layer at request time (buildRoute),
   *      deduped by id+phase so a seeded/edited entry wins.
   * See src/providers/quirks.ts familyDefaultTransforms + engine buildRoute.
   */
  defaultTransforms?: ModelTransformConfig[];
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
