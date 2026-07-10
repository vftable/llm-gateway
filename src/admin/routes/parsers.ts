// Body parsers (coerce + strip unknown fields) shared across route modules.
// Absent fields stay `undefined` so partial PUTs (e.g. an inline enable
// toggle) never wipe unrelated columns; the repos merge undefined = keep.
// `requireCreate` enforces required fields on POST.

import { normBasePath, type ProviderInput } from "../../repo/providers";
import type { ModelInput } from "../../repo/models";
import type { UserInput } from "../../repo/users";
import type { ApiKeyInput } from "../../repo/api-keys";
import type {
  ModelCapabilities,
  ModelTransformConfig,
  WireKind,
} from "../../types";

// Trimmed string, or undefined when not a string (absent field).
export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v.trim() : undefined;
}
export function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function parseProviderInput(
  body: unknown,
  requireCreate = false,
): ProviderInput {
  const b = (body || {}) as Record<string, unknown>;
  if (requireCreate) {
    if (!str(b.name)) throw new Error("name is required");
    if (!str(b.baseUrl)) throw new Error("baseUrl is required");
  }
  return {
    name: str(b.name) as string,
    baseUrl: str(b.baseUrl) as string,
    host:
      b.host === undefined ? undefined : b.host == null ? null : str(b.host),
    apiKeys: Array.isArray(b.apiKeys)
      ? (b.apiKeys as unknown[]).filter(
          (k): k is string => typeof k === "string",
        )
      : undefined,
    disabledApiKeys: Array.isArray(b.disabledApiKeys)
      ? (b.disabledApiKeys as unknown[]).filter(
          (k): k is string => typeof k === "string",
        )
      : undefined,
    authScheme: b.authScheme as ProviderInput["authScheme"],
    extraHeaders:
      b.extraHeaders && typeof b.extraHeaders === "object"
        ? (b.extraHeaders as Record<string, string>)
        : undefined,
    retryAttempts: num(b.retryAttempts),
    retryIntervalMs: num(b.retryIntervalMs),
    requestTimeoutMs: num(b.requestTimeoutMs),
    tlsVerify: b.tlsVerify === undefined ? undefined : !!b.tlsVerify,
    enabled: b.enabled === undefined ? undefined : !!b.enabled,
    // format is a nullable generic-adapter hint: "anthropic"/"openai" set it,
    // explicit null clears it, absent leaves it unchanged.
    format:
      b.format === undefined
        ? undefined
        : b.format === "anthropic" || b.format === "openai"
          ? b.format
          : null,
    endpoints: Array.isArray(b.endpoints)
      ? (b.endpoints as unknown[]).filter(
          (k): k is WireKind =>
            k === "chat" || k === "messages" || k === "responses",
        )
      : undefined,
    endpointPaths: parseEndpointPaths(b.endpointPaths),
    nativeConversion:
      b.nativeConversion === undefined ? undefined : !!b.nativeConversion,
    catalogId:
      b.catalogId === undefined
        ? undefined
        : b.catalogId == null
          ? null
          : str(b.catalogId),
    // Normalized here too (not just inside createProvider/updateProvider) so
    // parseProviderInput's OWN output is self-consistent — any future caller
    // of this parser gets an already-clean value, not one that merely happens
    // to be safe because of where it's currently used.
    basePath:
      b.basePath === undefined ? undefined : normBasePath(str(b.basePath)),
    modelsPath:
      b.modelsPath === undefined ? undefined : (str(b.modelsPath) ?? ""),
    proxy:
      b.proxy === undefined ? undefined : b.proxy == null ? null : str(b.proxy),
    country:
      b.country === undefined
        ? undefined
        : b.country == null
          ? null
          : str(b.country),
  };
}

export function parseModelInput(
  body: unknown,
  requireCreate = false,
): ModelInput {
  const b = (body || {}) as Record<string, unknown>;
  if (requireCreate && !str(b.alias)) throw new Error("alias is required");
  return {
    alias: str(b.alias) as string,
    displayName:
      b.displayName === undefined
        ? undefined
        : b.displayName == null
          ? null
          : str(b.displayName),
    contextWindow:
      b.contextWindow === undefined
        ? undefined
        : b.contextWindow == null
          ? null
          : num(b.contextWindow),
    maxOutputTokens:
      b.maxOutputTokens === undefined
        ? undefined
        : b.maxOutputTokens == null
          ? null
          : num(b.maxOutputTokens),
    enabled: b.enabled === undefined ? undefined : !!b.enabled,
    responsesNative:
      b.responsesNative === undefined ? undefined : !!b.responsesNative,
    type: b.type === "anthropic" || b.type === "openai" ? b.type : undefined,
    capabilities: b.capabilities as ModelCapabilities | undefined,
    providers: Array.isArray(b.providers)
      ? (b.providers as Array<Record<string, unknown>>).map((p) => ({
          providerId: str(p.providerId) ?? "",
          upstreamModel: str(p.upstreamModel) ?? "",
          enabled: p.enabled === undefined ? undefined : !!p.enabled,
          endpoint: p.endpoint == null ? null : str(p.endpoint),
          contextWindow: p.contextWindow == null ? null : num(p.contextWindow),
          maxOutputTokens:
            p.maxOutputTokens == null ? null : num(p.maxOutputTokens),
        }))
      : undefined,
  };
}

// Coerce a raw transforms payload into ModelTransformConfig[]. Skips malformed
// entries defensively; unknown ids are tolerated (resolved/ignored at apply).
export function parseTransformConfig(v: unknown): ModelTransformConfig[] {
  if (!Array.isArray(v)) return [];
  const out: ModelTransformConfig[] = [];
  for (const raw of v) {
    const t = raw as Record<string, unknown>;
    const id = str(t.id);
    const phase = t.phase === "response" ? "response" : "request";
    if (!id) continue;
    out.push({
      id,
      phase,
      params:
        t.params && typeof t.params === "object" && !Array.isArray(t.params)
          ? (t.params as Record<string, unknown>)
          : {},
    });
  }
  return out;
}

// Capabilities are an Anthropic-style object captured at import; we store them
// as informational metadata (a plain object passthrough) or null. Anything that
// isn't a plain object (array, primitive) normalizes to null.
export function parseCapabilities(v: unknown): ModelCapabilities | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as ModelCapabilities)
    : null;
}

// Per-kind endpoint path overrides: keep only known kinds → non-empty strings.
export function parseEndpointPaths(
  v: unknown,
): Partial<Record<WireKind, string>> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Partial<Record<WireKind, string>> = {};
  for (const k of ["chat", "messages", "responses"] as const) {
    const val = (v as Record<string, unknown>)[k];
    if (typeof val === "string" && val.trim()) out[k] = val.trim();
  }
  return out;
}

export function parseUserInput(
  body: unknown,
  requireCreate = false,
): UserInput {
  const b = (body || {}) as Record<string, unknown>;
  if (requireCreate && !str(b.name)) throw new Error("name is required");
  return {
    name: str(b.name) as string,
    email:
      b.email === undefined ? undefined : b.email == null ? null : str(b.email),
    enabled: b.enabled === undefined ? undefined : !!b.enabled,
    notes:
      b.notes === undefined ? undefined : b.notes == null ? null : str(b.notes),
  };
}

export function parseApiKeyInput(body: unknown): ApiKeyInput {
  const b = (body || {}) as Record<string, unknown>;
  return {
    name:
      b.name === undefined ? undefined : b.name == null ? null : str(b.name),
    userId:
      b.userId === undefined
        ? undefined
        : b.userId == null
          ? null
          : str(b.userId),
    tokensPerDay:
      b.tokensPerDay === undefined
        ? undefined
        : b.tokensPerDay == null || b.tokensPerDay === ""
          ? null
          : (num(b.tokensPerDay) ?? null),
    enabled: b.enabled === undefined ? undefined : !!b.enabled,
  };
}
