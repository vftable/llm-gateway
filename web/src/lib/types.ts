// API DTOs — mirror the backend's src/shared/types.ts shapes.

export type AuthScheme = "bearer" | "xapikey" | "both" | "passthrough";
export type ProviderFormat = "anthropic" | "openai";

export const ENDPOINTS = [
  "/v1/messages",
  "/v1/chat/completions",
  "/v1/responses",
] as const;

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  host: string | null;
  apiKeys: string[];
  authScheme: AuthScheme;
  extraHeaders: Record<string, string>;
  retryAttempts: number;
  retryIntervalMs: number;
  requestTimeoutMs: number;
  tlsVerify: boolean;
  enabled: boolean;
  format: ProviderFormat;
  endpoints: string[];
  nativeConversion: boolean;
  createdAt: string;
  updatedAt: string;
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
}

export interface ProviderInput {
  name: string;
  baseUrl: string;
  host?: string | null;
  apiKeys?: string[];
  authScheme?: AuthScheme;
  extraHeaders?: Record<string, string>;
  retryAttempts?: number;
  retryIntervalMs?: number;
  requestTimeoutMs?: number;
  tlsVerify?: boolean;
  enabled?: boolean;
  format?: ProviderFormat;
  endpoints?: string[];
  nativeConversion?: boolean;
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
  }>;
}

export interface ProviderTestResult {
  ok: boolean;
  status: number | null;
  ms: number;
  error?: string;
  sample?: string;
}

export interface UpstreamModelsResponse {
  models: string[];
  error?: string;
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
