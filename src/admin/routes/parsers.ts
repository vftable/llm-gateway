// Body parsers (coerce + strip unknown fields) shared across route modules.
// Absent fields stay `undefined` so partial PUTs (e.g. an inline enable
// toggle) never wipe unrelated columns; the repos merge undefined = keep.
// `requireCreate` enforces required fields on POST.

import { normBasePath, type ProviderInput } from "../../repo/providers";
import type {
  BatchModelLinkOps,
  ModelInput,
  ModelLinkIdentity,
  ModelLinkInput,
} from "../../repo/models";
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
    providerConfig:
      b.providerConfig && typeof b.providerConfig === "object"
        ? (b.providerConfig as Record<string, unknown>)
        : undefined,
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
    pricing:
      b.pricing === undefined
        ? undefined
        : b.pricing == null
          ? null
          : (() => {
              const p = b.pricing as Record<string, unknown>;
              return {
                promptPer1m: p.promptPer1m == null ? null : num(p.promptPer1m),
                completionPer1m:
                  p.completionPer1m == null ? null : num(p.completionPer1m),
                cachedPer1m:
                  p.cachedPer1m == null ? null : num(p.cachedPer1m),
              };
            })(),
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

// ---------------------------------------------------------------------------
// Provider key parsers
// ---------------------------------------------------------------------------

import type { ProviderKeyInput, BatchKeyOps } from "../../repo/provider-keys";

function parseStringRecord(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

export function parseProviderKeyInput(body: unknown): ProviderKeyInput {
  const b = (body || {}) as Record<string, unknown>;
  const credential = str(b.credential);
  if (!credential) throw new Error("credential is required");
  return {
    credential,
    enabled: b.enabled === undefined ? undefined : !!b.enabled,
    metadata: parseStringRecord(b.metadata),
    label:
      b.label === undefined ? undefined : b.label == null ? null : str(b.label),
  };
}

export function parseProviderKeyUpdate(
  body: unknown,
): Partial<Omit<ProviderKeyInput, "credential">> {
  const b = (body || {}) as Record<string, unknown>;
  return {
    enabled: b.enabled === undefined ? undefined : !!b.enabled,
    metadata:
      b.metadata === undefined ? undefined : parseStringRecord(b.metadata),
    label:
      b.label === undefined ? undefined : b.label == null ? null : str(b.label),
  };
}

const MAX_BATCH_OPS = 5000;

export function parseBatchKeyOps(body: unknown): BatchKeyOps {
  const b = (body || {}) as Record<string, unknown>;
  const ops: BatchKeyOps = {};

  if (Array.isArray(b.add)) {
    ops.add = (b.add as unknown[]).map((item) => {
      const i = (item || {}) as Record<string, unknown>;
      const credential = str(i.credential);
      if (!credential) throw new Error("each add item requires a credential");
      return {
        credential,
        enabled: i.enabled === undefined ? undefined : !!i.enabled,
        metadata: parseStringRecord(i.metadata),
        label: i.label == null ? undefined : str(i.label),
      };
    });
  }

  if (Array.isArray(b.remove))
    ops.remove = (b.remove as unknown[]).filter(
      (k): k is string => typeof k === "string" && k.length > 0,
    );

  if (Array.isArray(b.update)) {
    ops.update = (b.update as unknown[]).map((item) => {
      const i = (item || {}) as Record<string, unknown>;
      const id = str(i.id);
      if (!id) throw new Error("each update item requires an id");
      return {
        id,
        enabled: i.enabled === undefined ? undefined : !!i.enabled,
        metadata:
          i.metadata === undefined ? undefined : parseStringRecord(i.metadata),
        label:
          i.label === undefined
            ? undefined
            : i.label == null
              ? null
              : str(i.label),
      };
    });
  }

  if (Array.isArray(b.enable))
    ops.enable = (b.enable as unknown[]).filter(
      (k): k is string => typeof k === "string" && k.length > 0,
    );

  if (Array.isArray(b.disable))
    ops.disable = (b.disable as unknown[]).filter(
      (k): k is string => typeof k === "string" && k.length > 0,
    );

  const total =
    (ops.add?.length ?? 0) +
    (ops.remove?.length ?? 0) +
    (ops.update?.length ?? 0) +
    (ops.enable?.length ?? 0) +
    (ops.disable?.length ?? 0);
  if (total === 0) throw new Error("batch must contain at least one operation");
  if (total > MAX_BATCH_OPS)
    throw new Error(
      `batch exceeds ${MAX_BATCH_OPS} operation limit (got ${total})`,
    );

  return ops;
}

export interface KeyImportRequest {
  url: string;
  headers?: Record<string, string>;
  mode?: "append" | "replace";
  defaultMetadata?: Record<string, string>;
}

export function parseKeyImportRequest(body: unknown): KeyImportRequest {
  const b = (body || {}) as Record<string, unknown>;
  const url = str(b.url);
  if (!url) throw new Error("url is required");
  try {
    new URL(url);
  } catch {
    throw new Error("url is not a valid URL");
  }
  return {
    url,
    headers: parseStringRecord(b.headers),
    mode: b.mode === "replace" ? "replace" : "append",
    defaultMetadata: parseStringRecord(b.defaultMetadata),
  };
}

export interface KeySyncInput {
  pollUrl: string;
  pollHeaders?: Record<string, string>;
  pollIntervalSec?: number;
  enabled?: boolean;
}

export function parseKeySyncInput(body: unknown): KeySyncInput {
  const b = (body || {}) as Record<string, unknown>;
  const pollUrl = str(b.pollUrl);
  if (!pollUrl) throw new Error("pollUrl is required");
  try {
    new URL(pollUrl);
  } catch {
    throw new Error("pollUrl is not a valid URL");
  }
  const interval = num(b.pollIntervalSec);
  if (interval !== undefined && interval < 30)
    throw new Error("pollIntervalSec must be >= 30");
  return {
    pollUrl,
    pollHeaders: parseStringRecord(b.pollHeaders),
    pollIntervalSec: interval,
    enabled: b.enabled === undefined ? undefined : !!b.enabled,
  };
}

// ---------------------------------------------------------------------------
// Batch parsers for other entities
// ---------------------------------------------------------------------------

export interface BatchApiKeyOps {
  create?: ApiKeyInput[];
  update?: Array<{ id: string } & ApiKeyInput>;
  delete?: string[];
  enable?: string[];
  disable?: string[];
}

export function parseBatchApiKeyOps(body: unknown): BatchApiKeyOps {
  const b = (body || {}) as Record<string, unknown>;
  const ops: BatchApiKeyOps = {};

  if (Array.isArray(b.create))
    ops.create = (b.create as unknown[]).map((item) => parseApiKeyInput(item));
  if (Array.isArray(b.update))
    ops.update = (b.update as unknown[]).map((item) => {
      const i = (item || {}) as Record<string, unknown>;
      const id = str(i.id);
      if (!id) throw new Error("each update item requires an id");
      return { id, ...parseApiKeyInput(item) };
    });
  if (Array.isArray(b.delete))
    ops.delete = (b.delete as unknown[]).filter(
      (k): k is string => typeof k === "string" && k.length > 0,
    );
  if (Array.isArray(b.enable))
    ops.enable = (b.enable as unknown[]).filter(
      (k): k is string => typeof k === "string" && k.length > 0,
    );
  if (Array.isArray(b.disable))
    ops.disable = (b.disable as unknown[]).filter(
      (k): k is string => typeof k === "string" && k.length > 0,
    );

  const total =
    (ops.create?.length ?? 0) +
    (ops.update?.length ?? 0) +
    (ops.delete?.length ?? 0) +
    (ops.enable?.length ?? 0) +
    (ops.disable?.length ?? 0);
  if (total === 0) throw new Error("batch must contain at least one operation");
  if (total > MAX_BATCH_OPS)
    throw new Error(
      `batch exceeds ${MAX_BATCH_OPS} operation limit (got ${total})`,
    );
  return ops;
}

export interface BatchModelOps {
  create?: ModelInput[];
  update?: Array<{ id: string } & Partial<ModelInput>>;
  delete?: string[];
  enable?: string[];
  disable?: string[];
}

export function parseBatchModelOps(body: unknown): BatchModelOps {
  const b = (body || {}) as Record<string, unknown>;
  const ops: BatchModelOps = {};

  if (Array.isArray(b.create))
    ops.create = (b.create as unknown[]).map((item) =>
      parseModelInput(item, true),
    );
  if (Array.isArray(b.update))
    ops.update = (b.update as unknown[]).map((item) => {
      const i = (item || {}) as Record<string, unknown>;
      const id = str(i.id);
      if (!id) throw new Error("each update item requires an id");
      return { id, ...parseModelInput(item) };
    });
  if (Array.isArray(b.delete))
    ops.delete = (b.delete as unknown[]).filter(
      (k): k is string => typeof k === "string" && k.length > 0,
    );
  if (Array.isArray(b.enable))
    ops.enable = (b.enable as unknown[]).filter(
      (k): k is string => typeof k === "string" && k.length > 0,
    );
  if (Array.isArray(b.disable))
    ops.disable = (b.disable as unknown[]).filter(
      (k): k is string => typeof k === "string" && k.length > 0,
    );

  const total =
    (ops.create?.length ?? 0) +
    (ops.update?.length ?? 0) +
    (ops.delete?.length ?? 0) +
    (ops.enable?.length ?? 0) +
    (ops.disable?.length ?? 0);
  if (total === 0) throw new Error("batch must contain at least one operation");
  if (total > MAX_BATCH_OPS)
    throw new Error(
      `batch exceeds ${MAX_BATCH_OPS} operation limit (got ${total})`,
    );
  return ops;
}

function parseModelLinkIdentity(value: unknown): ModelLinkIdentity {
  const item = (value || {}) as Record<string, unknown>;
  const providerId = str(item.providerId);
  const upstreamModel = str(item.upstreamModel);
  if (!providerId || !upstreamModel)
    throw new Error("each model link requires providerId and upstreamModel");
  return { providerId, upstreamModel };
}

function parseModelLink(value: unknown): ModelLinkInput {
  const item = (value || {}) as Record<string, unknown>;
  const identity = parseModelLinkIdentity(item);
  return {
    ...identity,
    enabled: item.enabled === undefined ? undefined : !!item.enabled,
    endpoint:
      item.endpoint === undefined
        ? undefined
        : item.endpoint === null
          ? null
          : str(item.endpoint),
    contextWindow:
      item.contextWindow === undefined
        ? undefined
        : item.contextWindow === null
          ? null
          : num(item.contextWindow),
    maxOutputTokens:
      item.maxOutputTokens === undefined
        ? undefined
        : item.maxOutputTokens === null
          ? null
          : num(item.maxOutputTokens),
  };
}

export function parseBatchModelLinkOps(body: unknown): BatchModelLinkOps {
  const b = (body || {}) as Record<string, unknown>;
  const ops: BatchModelLinkOps = {};
  if (Array.isArray(b.add)) ops.add = b.add.map(parseModelLink);
  if (Array.isArray(b.remove))
    ops.remove = b.remove.map(parseModelLinkIdentity);
  if (Array.isArray(b.update)) ops.update = b.update.map(parseModelLink);
  if (Array.isArray(b.reorder))
    ops.reorder = b.reorder.map(parseModelLinkIdentity);

  const total =
    (ops.add?.length ?? 0) +
    (ops.remove?.length ?? 0) +
    (ops.update?.length ?? 0) +
    (ops.reorder?.length ?? 0);
  if (total === 0) throw new Error("batch must contain at least one operation");
  if (total > MAX_BATCH_OPS)
    throw new Error(
      `batch exceeds ${MAX_BATCH_OPS} operation limit (got ${total})`,
    );
  return ops;
}

export interface BatchProviderOps {
  update?: Array<{ id: string } & Partial<ProviderInput>>;
  delete?: string[];
  enable?: string[];
  disable?: string[];
}

export function parseBatchProviderOps(body: unknown): BatchProviderOps {
  const b = (body || {}) as Record<string, unknown>;
  const ops: BatchProviderOps = {};

  if (Array.isArray(b.update))
    ops.update = (b.update as unknown[]).map((item) => {
      const i = (item || {}) as Record<string, unknown>;
      const id = str(i.id);
      if (!id) throw new Error("each update item requires an id");
      return { id, ...parseProviderInput(item) };
    });
  if (Array.isArray(b.delete))
    ops.delete = (b.delete as unknown[]).filter(
      (k): k is string => typeof k === "string" && k.length > 0,
    );
  if (Array.isArray(b.enable))
    ops.enable = (b.enable as unknown[]).filter(
      (k): k is string => typeof k === "string" && k.length > 0,
    );
  if (Array.isArray(b.disable))
    ops.disable = (b.disable as unknown[]).filter(
      (k): k is string => typeof k === "string" && k.length > 0,
    );

  const total =
    (ops.update?.length ?? 0) +
    (ops.delete?.length ?? 0) +
    (ops.enable?.length ?? 0) +
    (ops.disable?.length ?? 0);
  if (total === 0) throw new Error("batch must contain at least one operation");
  if (total > MAX_BATCH_OPS)
    throw new Error(
      `batch exceeds ${MAX_BATCH_OPS} operation limit (got ${total})`,
    );
  return ops;
}
