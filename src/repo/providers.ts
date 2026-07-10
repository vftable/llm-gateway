// Providers repository. CRUD + typed row mapping for upstream provider configs.

import type { Database as DB } from "better-sqlite3";
import { randomBytes } from "crypto";
import type { AuthScheme, Provider, ProviderFormat, WireKind } from "../types";
import { wireKindOf } from "../providers/base";
import { parseJsonArray, parseJsonObject, isString } from "./json";

interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  host: string | null;
  api_keys: string;
  disabled_api_keys: string | null;
  auth_scheme: string;
  extra_headers: string;
  retry_attempts: number;
  retry_interval_ms: number;
  request_timeout_ms: number;
  tls_verify: number;
  enabled: number;
  format: string | null;
  endpoints: string;
  endpoint_paths: string | null;
  native_conversion: number;
  catalog_id: string | null;
  base_path: string | null;
  models_path: string | null;
  proxy: string | null;
  country: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// Read stored endpoints as wire KINDS. Tolerant of legacy path-string rows
// (converts "/v1/chat/completions" → "chat") so an un-migrated row still maps.
function readEndpointKinds(raw: string): WireKind[] {
  const seen = new Set<WireKind>();
  for (const e of parseJsonArray(raw, isString))
    seen.add(wireKindOf(e, "chat"));
  return [...seen];
}

export function mapProvider(r: ProviderRow): Provider {
  const apiKeys = parseJsonArray(r.api_keys, isString);
  const disabledApiKeys = parseJsonArray(r.disabled_api_keys, isString);
  const extraHeaders = parseJsonObject<Record<string, string>>(
    r.extra_headers,
    {},
  );
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    host: r.host,
    apiKeys,
    disabledApiKeys,
    authScheme: (r.auth_scheme as AuthScheme) || "bearer",
    extraHeaders,
    retryAttempts: r.retry_attempts,
    retryIntervalMs: r.retry_interval_ms,
    requestTimeoutMs: r.request_timeout_ms,
    tlsVerify: !!r.tls_verify,
    enabled: !!r.enabled,
    // null = derive from adapter / generic-openai fallback (not stored openai).
    format: (r.format as ProviderFormat | null) ?? null,
    endpoints: readEndpointKinds(r.endpoints),
    endpointPaths: parseJsonObject<Partial<Record<WireKind, string>>>(
      r.endpoint_paths,
      {},
    ),
    nativeConversion: !!r.native_conversion,
    catalogId: r.catalog_id ?? null,
    basePath: r.base_path ?? "",
    modelsPath: r.models_path || "/v1/models",
    proxy: r.proxy ?? null,
    country: r.country ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listProviders(db: DB, includeDisabled = true): Provider[] {
  const rows = db
    .prepare("SELECT * FROM providers ORDER BY sort_order, name")
    .all() as ProviderRow[];
  const all = rows.map(mapProvider);
  return includeDisabled ? all : all.filter((p) => p.enabled);
}

export function getProvider(db: DB, id: string): Provider | null {
  const row = db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as
    ProviderRow | undefined;
  return row ? mapProvider(row) : null;
}

export interface ProviderInput {
  id?: string;
  name: string;
  baseUrl: string;
  host?: string | null;
  apiKeys?: string[];
  disabledApiKeys?: string[];
  authScheme?: AuthScheme;
  extraHeaders?: Record<string, string>;
  retryAttempts?: number;
  retryIntervalMs?: number;
  requestTimeoutMs?: number;
  tlsVerify?: boolean;
  enabled?: boolean;
  format?: ProviderFormat | null;
  endpoints?: WireKind[];
  endpointPaths?: Partial<Record<WireKind, string>>;
  nativeConversion?: boolean;
  catalogId?: string | null;
  basePath?: string;
  modelsPath?: string;
  proxy?: string | null;
  country?: string | null;
}

// Generate a unique provider id DECOUPLED from name: a readable slug stem (when
// the name yields one) plus a short random suffix, so two providers can share a
// name (or catalog) and still get distinct ids. An explicit `input.id` is honored
// verbatim (config-sync ids like "config-upstream"); a bare generated id retries
// on the astronomically unlikely clash.
function generateProviderId(db: DB, name: string): string {
  const stem = slugify(name);
  for (let i = 0; i < 8; i++) {
    const id = stem ? `${stem}-${randSuffix()}` : `prov-${randSuffix()}`;
    if (!getProvider(db, id)) return id;
  }
  // Fall back to a long unique token if we somehow keep colliding.
  return `prov-${randSuffix()}${randSuffix()}`;
}

// Non-secret id suffix (a DB uniqueness token, visible in the admin UI — never
// a credential). Uses crypto.randomBytes rather than Math.random purely to keep
// it out of "insecure randomness" scanner rules; the collision math doesn't
// actually depend on CSPRNG-grade unpredictability here.
function randSuffix(): string {
  return randomBytes(4).toString("hex");
}

export function createProvider(db: DB, input: ProviderInput): Provider {
  const now = new Date().toISOString();
  const id = input.id || generateProviderId(db, input.name);
  if (getProvider(db, id)) throw new Error(`Provider '${id}' already exists`);
  db.prepare(
    `INSERT INTO providers
      (id, name, base_url, host, api_keys, disabled_api_keys, auth_scheme, extra_headers,
       retry_attempts, retry_interval_ms, request_timeout_ms, tls_verify,
       enabled, format, endpoints, endpoint_paths, native_conversion, catalog_id,
       base_path, models_path, proxy, country, sort_order, created_at, updated_at)
     VALUES (@id, @name, @base_url, @host, @api_keys, @disabled_api_keys, @auth_scheme, @extra_headers,
       @retry_attempts, @retry_interval_ms, @request_timeout_ms, @tls_verify,
       @enabled, @format, @endpoints, @endpoint_paths, @native_conversion, @catalog_id,
       @base_path, @models_path, @proxy, @country, @sort_order, @created_at, @updated_at)`,
  ).run({
    id,
    name: input.name,
    base_url: input.baseUrl.replace(/\/+$/, ""),
    host: input.host ?? null,
    api_keys: JSON.stringify(
      (input.apiKeys ?? []).filter((k) => k && k.length),
    ),
    disabled_api_keys: JSON.stringify(
      (input.disabledApiKeys ?? []).filter((k) => k && k.length),
    ),
    auth_scheme: input.authScheme || "bearer",
    extra_headers: JSON.stringify(input.extraHeaders ?? {}),
    retry_attempts: input.retryAttempts ?? 1,
    retry_interval_ms: input.retryIntervalMs ?? 3000,
    request_timeout_ms: input.requestTimeoutMs ?? 600000,
    tls_verify: input.tlsVerify === false ? 0 : 1,
    enabled: input.enabled === false ? 0 : 1,
    // Persist null unless explicitly set — format is only a generic-adapter hint.
    format: input.format ?? null,
    endpoints: JSON.stringify(
      input.endpoints ?? defaultEndpoints(input.format),
    ),
    endpoint_paths: JSON.stringify(input.endpointPaths ?? {}),
    native_conversion: input.nativeConversion ? 1 : 0,
    catalog_id: input.catalogId ?? null,
    base_path: normBasePath(input.basePath),
    models_path: input.modelsPath || "/v1/models",
    proxy: input.proxy || null,
    country: input.country || null,
    sort_order: 0,
    created_at: now,
    updated_at: now,
  });
  return getProvider(db, id)!;
}

// Default endpoint KINDS for a provider with no explicit endpoints: anthropic →
// messages, else chat. Only used for bare custom providers; adapter-backed ones
// carry their own template endpoints.
export function defaultEndpoints(
  format: ProviderFormat | null | undefined,
): WireKind[] {
  return format === "anthropic" ? ["messages"] : ["chat"];
}

// Normalize a base path: empty stays empty (legacy full-path endpoints); a set
// value is ensured to start with "/" and have no trailing slash, so
// `origin + basePath + suffix` composes cleanly.
export function normBasePath(bp: string | undefined | null): string {
  const s = (bp ?? "").trim();
  if (!s || s === "/") return "";
  const withLead = s.startsWith("/") ? s : "/" + s;
  return withLead.replace(/\/+$/, "");
}

export function updateProvider(
  db: DB,
  id: string,
  input: Partial<ProviderInput>,
): Provider | null {
  const existing = getProvider(db, id);
  if (!existing) return null;
  const now = new Date().toISOString();
  // format is nullable: a caller may explicitly set it to null (clear the hint).
  const format = input.format !== undefined ? input.format : existing.format;
  // When format changes and no endpoints are supplied, reseed from the new format.
  const endpoints =
    input.endpoints ??
    (input.format !== undefined
      ? defaultEndpoints(format)
      : existing.endpoints);
  const endpointPaths =
    input.endpointPaths !== undefined
      ? input.endpointPaths
      : existing.endpointPaths;
  const next = {
    name: input.name ?? existing.name,
    baseUrl: input.baseUrl ?? existing.baseUrl,
    host: input.host !== undefined ? input.host : existing.host,
    apiKeys: input.apiKeys ?? existing.apiKeys,
    disabledApiKeys: input.disabledApiKeys ?? existing.disabledApiKeys,
    authScheme: input.authScheme ?? existing.authScheme,
    extraHeaders: input.extraHeaders ?? existing.extraHeaders,
    retryAttempts: input.retryAttempts ?? existing.retryAttempts,
    retryIntervalMs: input.retryIntervalMs ?? existing.retryIntervalMs,
    requestTimeoutMs: input.requestTimeoutMs ?? existing.requestTimeoutMs,
    tlsVerify:
      input.tlsVerify !== undefined ? input.tlsVerify : existing.tlsVerify,
    enabled: input.enabled !== undefined ? input.enabled : existing.enabled,
    nativeConversion:
      input.nativeConversion !== undefined
        ? input.nativeConversion
        : existing.nativeConversion,
    catalogId:
      input.catalogId !== undefined ? input.catalogId : existing.catalogId,
    basePath: input.basePath !== undefined ? input.basePath : existing.basePath,
    modelsPath:
      input.modelsPath !== undefined ? input.modelsPath : existing.modelsPath,
    proxy: input.proxy !== undefined ? input.proxy : existing.proxy,
    country: input.country !== undefined ? input.country : existing.country,
  };
  db.prepare(
    `UPDATE providers SET
       name=@name, base_url=@base_url, host=@host, api_keys=@api_keys,
       disabled_api_keys=@disabled_api_keys,
       auth_scheme=@auth_scheme, extra_headers=@extra_headers,
       retry_attempts=@retry_attempts, retry_interval_ms=@retry_interval_ms,
       request_timeout_ms=@request_timeout_ms, tls_verify=@tls_verify,
       enabled=@enabled, format=@format, endpoints=@endpoints,
       endpoint_paths=@endpoint_paths,
       native_conversion=@native_conversion, catalog_id=@catalog_id,
       base_path=@base_path, models_path=@models_path, proxy=@proxy,
       country=@country, updated_at=@updated_at
     WHERE id=@id`,
  ).run({
    id,
    name: next.name,
    base_url: next.baseUrl.replace(/\/+$/, ""),
    host: next.host ?? null,
    api_keys: JSON.stringify((next.apiKeys ?? []).filter((k) => k && k.length)),
    disabled_api_keys: JSON.stringify(
      (next.disabledApiKeys ?? []).filter((k) => k && k.length),
    ),
    auth_scheme: next.authScheme || "bearer",
    extra_headers: JSON.stringify(next.extraHeaders ?? {}),
    retry_attempts: next.retryAttempts ?? 1,
    retry_interval_ms: next.retryIntervalMs ?? 3000,
    request_timeout_ms: next.requestTimeoutMs ?? 600000,
    tls_verify: next.tlsVerify === false ? 0 : 1,
    enabled: next.enabled === false ? 0 : 1,
    format: format ?? null,
    endpoints: JSON.stringify(endpoints),
    endpoint_paths: JSON.stringify(endpointPaths ?? {}),
    native_conversion: next.nativeConversion ? 1 : 0,
    catalog_id: next.catalogId ?? null,
    base_path: normBasePath(next.basePath),
    models_path: next.modelsPath || "/v1/models",
    proxy: next.proxy || null,
    country: next.country || null,
    updated_at: now,
  });
  return getProvider(db, id);
}

export function deleteProvider(db: DB, id: string): boolean {
  const r = db.prepare("DELETE FROM providers WHERE id = ?").run(id);
  return r.changes > 0;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
