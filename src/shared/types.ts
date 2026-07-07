// Shared domain types used across the backend (db -> repo -> gateway -> admin).
// The frontend mirrors these shapes in web/src/lib/types.ts.

export type AuthScheme = "bearer" | "xapikey" | "both" | "passthrough";

export const AUTH_SCHEMES: AuthScheme[] = [
  "bearer",
  "xapikey",
  "both",
  "passthrough",
];

// What wire format a provider speaks natively. Drives the default endpoint
// and how the gateway converts when the client speaks the other format.
export type ProviderFormat = "anthropic" | "openai";

export const PROVIDER_FORMATS: ProviderFormat[] = ["anthropic", "openai"];

// The three LLM request endpoints the gateway understands. Providers declare
// which subset they support; each model->provider link picks one to route
// through.
export const ENDPOINT_MESSAGES = "/v1/messages";
export const ENDPOINT_CHAT = "/v1/chat/completions";
export const ENDPOINT_RESPONSES = "/v1/responses";
export const ALL_ENDPOINTS = [
  ENDPOINT_MESSAGES,
  ENDPOINT_CHAT,
  ENDPOINT_RESPONSES,
] as const;
export type EndpointPath = (typeof ALL_ENDPOINTS)[number];

// --- Model capabilities (Anthropic-style listing shape) ---------------------

export interface CapabilitySupport {
  supported: boolean;
}

export interface ThinkingCapability {
  supported: boolean;
  types: {
    adaptive: CapabilitySupport;
    enabled: CapabilitySupport;
  };
}

export interface EffortCapability {
  supported: boolean;
  low: CapabilitySupport;
  medium: CapabilitySupport;
  high: CapabilitySupport;
  xhigh: CapabilitySupport;
  max: CapabilitySupport;
}

export interface ContextManagementCapability {
  supported: boolean;
  clear_tool_uses_20250919: CapabilitySupport;
  clear_thinking_20251015: CapabilitySupport;
  compact_20260112: CapabilitySupport;
}

export interface ModelCapabilities {
  batch: CapabilitySupport;
  citations: CapabilitySupport;
  code_execution: CapabilitySupport;
  context_management?: ContextManagementCapability;
  image_input: CapabilitySupport;
  pdf_input: CapabilitySupport;
  structured_outputs: CapabilitySupport;
  thinking: ThinkingCapability;
  effort: EffortCapability;
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

// --- Core entities ----------------------------------------------------------

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
  /** Native wire format. anthropic -> /v1/messages, openai -> /v1/chat/completions(+responses). */
  format: ProviderFormat;
  /** Endpoints this provider accepts (subset of ALL_ENDPOINTS). */
  endpoints: string[];
  /**
   * When true, the provider accepts EITHER format and converts internally
   * (e.g. LiteLLM/9router). The gateway then forwards the client's request
   * unchanged to the client's original path. When false, the gateway converts
   * the client's request to the link's endpoint format itself.
   */
  nativeConversion: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ModelProviderLink {
  providerId: string;
  providerName: string | null;
  upstreamModel: string;
  priority: number;
  enabled: boolean;
  /** Endpoint to route this model through on this provider. */
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
  /**
   * True when the alias matches an official Anthropic model: capabilities are
   * pinned to the stock Anthropic entry and edits to them are ignored.
   */
  capabilitiesLocked: boolean;
  providers: ModelProviderLink[]; // ordered fallback chain
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
  keyFull?: string; // only populated on creation (never re-read afterward)
  userId: string | null;
  userName: string | null;
  tokensPerDay: number | null; // null = unlimited
  enabled: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface KeyUsage {
  tokens: number;
  day: string; // YYYY-MM-DD (UTC)
}

export interface RequestLog {
  id: number;
  ts: string;
  apiKeyId: string | null;
  apiKeyName: string | null;
  /** Live-joined masked key ("sk-…") for display; null when key was deleted. */
  keyPrefix: string | null;
  userId: string | null;
  model: string | null;
  providerId: string | null;
  providerName: string | null;
  upstreamModel: string | null;
  status: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  client: string | null;
  path: string | null;
  stream: boolean;
  error: string | null;
}

// --- Global settings (key/value store, typed view) --------------------------

export interface Settings {
  modelPrefix: string;
  exposePrefix: string;
  exposeExempt: string[];
  allowUnknown: boolean;
  defaultMaxOutputTokens: number;
  ssePingInterval: number;
  requestLogRetentionDays: number;
  adminPasswordHash: string | null;
  jwtSecret: string;
}

export const DEFAULT_SETTINGS: Settings = {
  modelPrefix: "",
  exposePrefix: "anthropic/",
  exposeExempt: ["claude"],
  allowUnknown: false,
  defaultMaxOutputTokens: 16384,
  ssePingInterval: 30000,
  requestLogRetentionDays: 30,
  adminPasswordHash: null,
  jwtSecret: "",
};
