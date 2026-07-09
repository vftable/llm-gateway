// Quirk application helpers.
//
// Quirks are declarative per-provider behaviors (required headers, thinking
// defaults, capability overrides). They are applied at provider-create and
// model-import time only — never on the request hot path — so they cannot
// regress streaming or format conversion.

import {
  DEFAULT_CAPABILITIES,
  type ModelCapabilities,
  type ProviderTemplate,
} from "../types";
import type { ProviderInput } from "../repo/providers";

// Build a ProviderInput from a template's defaults + a template's required
// headers, merged under any user-supplied overrides. User values win.
export function applyTemplateDefaults(
  template: ProviderTemplate,
  input: Partial<ProviderInput>,
): Partial<ProviderInput> {
  const d = template.defaults;
  const requiredHeaders = template.quirks?.requiredHeaders ?? {};
  // Required headers first, then template default headers, then user headers.
  const extraHeaders = {
    ...requiredHeaders,
    ...(d.extraHeaders ?? {}),
    ...(input.extraHeaders ?? {}),
  };
  // Spread the caller's fields first (carries name/apiKeys/enabled through),
  // then apply the resolved config so a resolved default isn't clobbered by an
  // explicit `undefined` in input.
  return {
    ...input,
    baseUrl: input.baseUrl ?? d.baseUrl,
    format: input.format ?? d.format,
    endpoints: input.endpoints ?? d.endpoints,
    authScheme: input.authScheme ?? d.authScheme,
    nativeConversion: input.nativeConversion ?? d.nativeConversion,
    retryAttempts: input.retryAttempts ?? d.retryAttempts,
    retryIntervalMs: input.retryIntervalMs ?? d.retryIntervalMs,
    requestTimeoutMs: input.requestTimeoutMs ?? d.requestTimeoutMs,
    tlsVerify: input.tlsVerify ?? d.tlsVerify,
    extraHeaders,
    catalogId: template.id,
  };
}

// Deep-ish merge of a template's capability overrides onto DEFAULT_CAPABILITIES.
// Only the top-level capability groups the quirk touches are replaced; used to
// seed a model imported from this provider.
export function capabilitiesForTemplate(
  template: ProviderTemplate,
): ModelCapabilities {
  const base: ModelCapabilities = structuredCloneCompat(DEFAULT_CAPABILITIES);
  const q = template.quirks;
  if (!q) return base;
  if (q.thinking) {
    base.thinking.supported = true;
    if (q.thinking.defaultType) {
      base.thinking.types.adaptive.supported =
        q.thinking.defaultType === "adaptive";
      base.thinking.types.enabled.supported =
        q.thinking.defaultType === "enabled";
    }
    if (q.thinking.supportsEffort !== undefined)
      base.effort.supported = q.thinking.supportsEffort;
  }
  if (q.defaultCapabilities) {
    Object.assign(base, q.defaultCapabilities);
  }
  return base;
}

// structuredClone exists on Node >=17 but keep a tiny fallback for safety.
function structuredCloneCompat<T>(v: T): T {
  if (typeof structuredClone === "function") return structuredClone(v);
  return JSON.parse(JSON.stringify(v)) as T;
}
