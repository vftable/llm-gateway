// Account + observability entities: users, API keys, per-key usage, request logs.

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
  /** Prompt tokens served from cache (subset of inputTokens); null if unknown. */
  cachedTokens: number | null;
  latencyMs: number | null;
  client: string | null;
  path: string | null;
  stream: boolean;
  error: string | null;
  /** True when captured request/response debug payloads exist for this row. */
  hasDebug: boolean;
}
