// API DTOs — mirror the backend's src/shared/types.ts shapes.

export type AuthScheme = "bearer" | "xapikey" | "both" | "passthrough";
export type ProviderFormat = "anthropic" | "openai";

// Endpoint KINDS a provider accepts (not paths — the adapter assembles the path).
export type WireKind = "chat" | "messages" | "responses";
export const WIRE_KINDS: WireKind[] = ["chat", "messages", "responses"];

// Human labels for the endpoint kinds (UI).
export const WIRE_KIND_LABELS: Record<WireKind, string> = {
  chat: "Chat Completions",
  messages: "Messages",
  responses: "Responses",
};

export interface KeyCount {
  enabled: number;
  disabled: number;
  total: number;
}

export interface ProviderKey {
  id: string;
  providerId: string;
  credential: string;
  credHash: string;
  enabled: boolean;
  metadata: Record<string, string>;
  label: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderKeyInput {
  credential: string;
  enabled?: boolean;
  metadata?: Record<string, string>;
  label?: string | null;
}

export interface BatchKeyOps {
  add?: ProviderKeyInput[];
  remove?: string[];
  update?: Array<{
    id: string;
    enabled?: boolean;
    metadata?: Record<string, string>;
    label?: string | null;
  }>;
  enable?: string[];
  disable?: string[];
}

export interface BatchKeyResult {
  added: number;
  removed: number;
  updated: number;
  enabled: number;
  disabled: number;
  duplicatesSkipped: number;
  errors: Array<{ op: string; detail: string }>;
  keys: ProviderKey[];
}

export interface ProviderKeySyncConfig {
  providerId: string;
  pollUrl: string;
  pollHeaders: Record<string, string>;
  pollIntervalSec: number;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  enabled: boolean;
}

export interface KeyImportRequest {
  url: string;
  headers?: Record<string, string>;
  mode?: "append" | "replace";
  defaultMetadata?: Record<string, string>;
}

export interface KeyImportResult {
  batch: BatchKeyResult;
  fetched: number;
  mode: "append" | "replace";
}

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  host: string | null;
  keyCount: KeyCount;
  authScheme: AuthScheme;
  extraHeaders: Record<string, string>;
  retryAttempts: number;
  retryIntervalMs: number;
  requestTimeoutMs: number;
  tlsVerify: boolean;
  enabled: boolean;
  /** Generic-adapter hint; null when adapter-backed or nativeConversion. */
  format: ProviderFormat | null;
  /** Endpoint KINDS this provider accepts. */
  endpoints: WireKind[];
  /** Optional per-kind path override for a non-standard layout. */
  endpointPaths: Partial<Record<WireKind, string>>;
  nativeConversion: boolean;
  /** Catalog template id this provider was created from, or null. */
  catalogId: string | null;
  /** Path prefix between origin and endpoint suffix (e.g. "/v1beta/openai"). */
  basePath: string;
  /** Model-discovery path, joined as origin+basePath+modelsPath. */
  modelsPath: string;
  /** Outbound proxy URL (socks5://…, http://…) or null for direct. */
  proxy: string | null;
  /** ISO-3166 alpha-2 country tag (UI flag only). */
  country: string | null;
  /** Generic per-instance config bag for adapter-specific settings. */
  providerConfig: Record<string, unknown>;
  /** Count of imported models in this provider's catalog (provider_models rows).
   *  Server-computed on the list endpoint; the card badge reads this. */
  importedModelCount?: number;
  createdAt: string;
  updatedAt: string;
}

// --- Provider key-usage report (upstream quota view) ---
export type UsageUnit = "tokens" | "requests" | "credits";

export interface ProviderKeyUsageWindow {
  id: string;
  label: string;
  used: number;
  limit: number;
  unit: UsageUnit;
  /** When this window's counter RESETS (refills) — absent for a one-shot
   *  balance that doesn't roll over (e.g. a prepaid credit grant). */
  resetsAt?: string;
}

export interface ProviderKeyUsage {
  keyMask: string;
  enabled: boolean;
  windows: ProviderKeyUsageWindow[];
  /** When the KEY ITSELF becomes invalid — distinct from a window's
   *  resetsAt, which refills rather than expiring. */
  expiresAt?: string;
  /** Provider can't report usage for this key — UI shows "Unavailable". */
  unavailable?: boolean;
  /** Optional free-text note for the key (tier, rate-limit, error detail). */
  message?: string;
}

export interface ProviderUsageReport {
  providerId: string;
  providerName: string;
  catalogId: string | null;
  brand: string;
  /**
   * Whether the adapter reports upstream usage at all. False = omitted from the
   * dashboard; `keys` is empty. The per-provider detail view shows a "not
   * reported" note instead.
   */
  supported: boolean;
  dummy: boolean;
  keys: ProviderKeyUsage[];
}

// --- Provider catalog (stock provider registry) ---
export interface ProviderDefaults {
  baseUrl?: string;
  basePath?: string;
  modelsPath?: string;
  format?: ProviderFormat;
  endpoints?: WireKind[];
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

export interface ProviderQuirks {
  requiredHeaders?: Record<string, string>;
  thinking?: { defaultType?: "adaptive" | "enabled"; supportsEffort?: boolean };
  defaultCapabilities?: Partial<ModelCapabilities>;
}

export interface TemplateField {
  key: "name" | "apiKeys" | "baseUrl";
  label: string;
  placeholder?: string;
  required?: boolean;
  editable?: boolean;
  hint?: string;
}

export interface ProviderTemplate {
  id: string;
  label: string;
  blurb: string;
  brand: string;
  defaults: ProviderDefaults;
  fields: TemplateField[];
  quirks?: ProviderQuirks;
  docsUrl?: string;
}

// --- Model capabilities (Anthropic-style listing shape; snake_case mirrors
// the wire format) ---

export interface CapabilitySupport {
  supported: boolean;
}

export interface ModelCapabilities {
  batch: CapabilitySupport;
  citations: CapabilitySupport;
  code_execution: CapabilitySupport;
  context_management?: {
    supported: boolean;
    clear_tool_uses_20250919: CapabilitySupport;
    clear_thinking_20251015: CapabilitySupport;
    compact_20260112: CapabilitySupport;
  };
  image_input: CapabilitySupport;
  pdf_input: CapabilitySupport;
  structured_outputs: CapabilitySupport;
  thinking: {
    supported: boolean;
    types: {
      adaptive: CapabilitySupport;
      enabled: CapabilitySupport;
    };
  };
  effort: {
    supported: boolean;
    low: CapabilitySupport;
    medium: CapabilitySupport;
    high: CapabilitySupport;
    xhigh: CapabilitySupport;
    max: CapabilitySupport;
  };
}

export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  batch: { supported: true },
  citations: { supported: false },
  code_execution: { supported: false },
  image_input: { supported: false },
  pdf_input: { supported: false },
  structured_outputs: { supported: true },
  thinking: {
    supported: true,
    types: {
      adaptive: { supported: true },
      enabled: { supported: true },
    },
  },
  effort: {
    supported: true,
    low: { supported: true },
    medium: { supported: true },
    high: { supported: true },
    xhigh: { supported: true },
    max: { supported: true },
  },
};

export interface ModelProviderLink {
  providerId: string;
  providerName: string | null;
  upstreamModel: string;
  priority: number;
  enabled: boolean;
  endpoint: string | null;
  /** Per-hop context-window override (null = inherit); oversized requests skip this hop. */
  contextWindow: number | null;
  /** Per-hop max-output override (null = inherit). */
  maxOutputTokens: number | null;
}

export interface ModelLinkIdentity {
  providerId: string;
  upstreamModel: string;
}

export interface ModelLinkInput extends ModelLinkIdentity {
  enabled?: boolean;
  endpoint?: string | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
}

export interface BatchModelLinkOps {
  add?: ModelLinkInput[];
  remove?: ModelLinkIdentity[];
  update?: ModelLinkInput[];
  /** Listed links move to the front in this exact order. */
  reorder?: ModelLinkIdentity[];
}

export interface BatchModelLinkResult {
  added: number;
  removed: number;
  updated: number;
  reordered: number;
  model: Model;
}

// --- Per-model transforms + imported provider models ---

export type TransformPhase = "request" | "response";

export interface ModelTransformConfig {
  id: string;
  phase: TransformPhase;
  params: Record<string, unknown>;
}

export type ParamType = "string" | "number" | "boolean";

export interface ParamSpec {
  key: string;
  label: string;
  type: ParamType;
  required?: boolean;
  placeholder?: string;
  hint?: string;
}

export interface TransformDefInfo {
  id: string;
  label: string;
  blurb: string;
  phases: TransformPhase[];
  params: ParamSpec[];
}

// --- Resolved transform stack (read-only preview of what a provider does) ----
// Mirrors src/admin/routes/resolved-transforms.ts's ResolvedTransforms exactly.
// GET /api/providers/:id/transforms/resolved — see docs/transforms-api.md
// § "The default provider transform stack".

export type TransformSource = "builtin" | "family" | "adapter" | "model";
export type ResolvedPhase = TransformPhase | "stream";

export interface ResolvedTransformStage {
  name: string;
  source: TransformSource;
  phase: ResolvedPhase;
  /** Human label — falls back to a humanized `name` in the UI when absent. */
  label?: string;
  blurb?: string;
  params?: Record<string, unknown>;
  /** Siblings (same phase+source) sharing a `group` string cluster under one
   *  collapsible row instead of showing individually. */
  group?: string;
  /** True for a `family` stage a model's own config overrides — shown
   *  separately in `overridden`, not in the live request/response/stream lists. */
  overridden?: boolean;
}

export interface ResolvedTransforms {
  providerId: string;
  catalogId: string | null;
  nativeFormat: ProviderFormat;
  nativeWireKind: WireKind;
  request: ResolvedTransformStage[];
  response: ResolvedTransformStage[];
  stream: ResolvedTransformStage[];
  overridden: ResolvedTransformStage[];
}

export interface ProviderModel {
  id: number;
  providerId: string;
  upstreamId: string;
  displayName: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  capabilities: ModelCapabilities | null;
  transforms: ModelTransformConfig[];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderModelInput {
  providerId?: string;
  upstreamId: string;
  displayName?: string | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  capabilities?: ModelCapabilities | null;
  transforms?: ModelTransformConfig[];
  notes?: string | null;
}

// The universal, dialect-agnostic model descriptor the /upstream-models endpoint
// returns (mirror of the backend UpstreamModel). Only `id` is guaranteed.
export interface UpstreamModel {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  created?: string;
  capabilities?: ModelCapabilities;
  raw?: Record<string, unknown>;
}

export interface Model {
  id: string;
  alias: string;
  displayName: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  enabled: boolean;
  responsesNative: boolean;
  type: string;
  capabilities: ModelCapabilities;
  /** True for official Anthropic aliases — capabilities are pinned server-side. */
  capabilitiesLocked: boolean;
  providers: ModelProviderLink[];
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  name: string;
  email: string | null;
  enabled: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKey {
  id: string;
  name: string | null;
  keyPrefix: string;
  keyFull?: string; // present only right after creation
  userId: string | null;
  userName: string | null;
  tokensPerDay: number | null;
  enabled: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface RequestLog {
  id: number;
  ts: string;
  apiKeyId: string | null;
  apiKeyName: string | null;
  keyPrefix: string | null;
  userId: string | null;
  model: string | null;
  providerId: string | null;
  providerName: string | null;
  upstreamModel: string | null;
  status: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  latencyMs: number | null;
  client: string | null;
  path: string | null;
  stream: boolean;
  error: string | null;
  hasDebug: boolean;
}

export interface RequestLogDetail {
  request: string | null;
  response: string | null;
}

export interface HopStat {
  providerId: string;
  upstreamModel: string;
  success: number;
  errors: number;
}

export interface DashboardStats {
  requestsToday: number;
  requestsErrorToday: number;
  tokensToday: number;
  errorRateToday: number;
  byModel: Array<{
    model: string;
    requests: number;
    tokens: number;
    cached: number;
  }>;
  byProvider: Array<{
    providerId: string;
    provider: string;
    requests: number;
    tokens: number;
  }>;
  statusBands: { success: number; clientError: number; serverError: number };
  p95LatencyMs: number | null;
}

export interface OverviewResponse {
  stats: DashboardStats;
  usageHistory: Array<{ day: string; tokens: number }>;
  hourlyUsage: Array<{ hour: string; tokens: number }>;
  providers: number;
  models: number;
  keys: number;
}

export interface UsageRow {
  apiKeyId: string;
  keyName: string | null;
  keyPrefix: string;
  userName: string | null;
  limit: number | null;
  used: number;
  day: string;
}

export interface UsageResponse {
  today: { total: number; keys: UsageRow[] };
  history: Array<{ day: string; tokens: number }>;
}

export interface Settings {
  modelPrefix: string;
  exposePrefix: string;
  exposeExempt: string[];
  allowUnknown: boolean;
  defaultMaxOutputTokens: number;
  ssePingInterval: number;
  requestLogRetentionDays: number;
  debugLogging: boolean;
  webToolsEnabled: boolean;
  webToolsProvider: string;
  webProviderBaseUrl: string;
  webProviderApiKey: string;
  /** Read-only: registered web-provider ids (for the picker). */
  webProviders?: string[];
}

export interface ProviderInput {
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
  providerConfig?: Record<string, unknown>;
}

export interface ModelInput {
  alias: string;
  displayName?: string | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  enabled?: boolean;
  responsesNative?: boolean;
  type?: string;
  capabilities?: ModelCapabilities;
  providers?: Array<{
    providerId: string;
    upstreamModel: string;
    enabled?: boolean;
    endpoint?: string | null;
    contextWindow?: number | null;
    maxOutputTokens?: number | null;
  }>;
}

export interface ProviderTestResult {
  ok: boolean;
  status: number | null;
  ms: number;
  error?: string;
  sample?: string;
  /** Masked form (head…tail) of the API key this test attempt actually sent —
   *  picked via the same rotation/health algorithm live traffic uses. Absent
   *  when the provider has no keys configured. */
  keyMask?: string;
}

export interface TestModelResult {
  ok: boolean;
  status: number | null;
  data: unknown;
  ms: number;
}

export interface ExposedModelTestResult {
  ok: boolean;
  status: number | null;
  data: unknown;
  ms: number;
  provider: { id: string; name: string | null } | null;
  upstreamModel: string | null;
  hopIndex: number;
}

export interface UpstreamModelsResponse {
  models: UpstreamModel[];
  error?: string;
}

// Ad-hoc connectivity test for a provider that doesn't exist yet (wizard).
export interface ProviderTestInput {
  baseUrl: string;
  apiKey?: string;
  host?: string | null;
  authScheme?: AuthScheme;
  tlsVerify?: boolean;
  extraHeaders?: Record<string, string>;
  basePath?: string;
  modelsPath?: string;
  proxy?: string | null;
}

// Pre-create test result: a ProviderTestResult plus discovered upstream models
// (universal shape, so the wizard imports the same rich metadata as the
// standalone importer).
export interface ProviderTestProbe extends ProviderTestResult {
  models: UpstreamModel[];
}

export interface UsageBreakdownRow {
  apiKeyId: string;
  model: string;
  providerId: string | null;
  providerName: string | null;
  tokens: number;
  requests: number;
}

export interface FullBreakdownRow extends UsageBreakdownRow {
  keyName: string | null;
  keyPrefix: string;
  userName: string | null;
}

export interface ModelResolutionRow {
  model: string;
  providerId: string | null;
  providerName: string | null;
  tokens: number;
  requests: number;
}
