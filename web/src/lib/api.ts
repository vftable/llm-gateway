// Thin fetch client for the admin API. The admin session token is kept in
// localStorage and attached as a Bearer header on every call. A 401 clears the
// token and bounces to /login.

import type {
  ApiKey,
  FullBreakdownRow,
  Model,
  ModelInput,
  ModelResolutionRow,
  OverviewResponse,
  Provider,
  ProviderInput,
  ProviderTestResult,
  ProviderTemplate,
  ProviderTestInput,
  ProviderTestProbe,
  ProviderModel,
  ProviderModelInput,
  TransformDefInfo,
  RequestLog,
  RequestLogDetail,
  Settings,
  UpstreamModelsResponse,
  UsageBreakdownRow,
  UsageResponse,
  User,
} from "./types";

const TOKEN_KEY = "gw_admin_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(opts.headers as Record<string, string> | undefined),
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...opts, headers });

  if (res.status === 401) {
    clearToken();
    if (location.pathname !== "/login") location.href = "/login";
    throw new ApiError("Unauthorized", 401);
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      const e = body?.error;
      message = (e && (e.message || e.type)) || message;
    } catch {
      /* keep default */
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

// --- auth ---
export const api = {
  login: (password: string) =>
    req<{ token: string }>("/api/auth/login", json("POST", { password })),
  check: () => req<{ ok: boolean }>("/api/auth/check"),

  overview: () => req<OverviewResponse>("/api/overview"),

  // providers
  listProviders: () => req<Provider[]>("/api/providers"),
  createProvider: (input: ProviderInput) =>
    req<Provider>("/api/providers", json("POST", input)),
  updateProvider: (id: string, input: ProviderInput) =>
    req<Provider>(`/api/providers/${id}`, json("PUT", input)),
  deleteProvider: (id: string) =>
    req<void>(`/api/providers/${id}`, { method: "DELETE" }),
  testProvider: (id: string) =>
    req<ProviderTestResult>(`/api/providers/${id}/test`, { method: "POST" }),
  upstreamModels: (id: string) =>
    req<UpstreamModelsResponse>(`/api/providers/${id}/upstream-models`),

  // provider catalog (stock provider registry)
  listProviderCatalog: () =>
    req<ProviderTemplate[]>("/api/provider-catalog"),
  testProviderConfig: (input: ProviderTestInput) =>
    req<ProviderTestProbe>("/api/provider-catalog/test", json("POST", input)),

  // models
  listModels: () => req<Model[]>("/api/models"),
  createModel: (input: ModelInput) =>
    req<Model>("/api/models", json("POST", input)),
  updateModel: (id: string, input: ModelInput) =>
    req<Model>(`/api/models/${id}`, json("PUT", input)),
  deleteModel: (id: string) =>
    req<void>(`/api/models/${id}`, { method: "DELETE" }),

  // imported provider models (per-provider catalog, not exposed)
  listProviderModels: (providerId: string) =>
    req<ProviderModel[]>(`/api/providers/${providerId}/models`),
  createProviderModel: (providerId: string, input: ProviderModelInput) =>
    req<ProviderModel>(`/api/providers/${providerId}/models`, json("POST", input)),
  updateProviderModel: (
    providerId: string,
    mid: number,
    input: ProviderModelInput,
  ) =>
    req<ProviderModel>(
      `/api/providers/${providerId}/models/${mid}`,
      json("PUT", input),
    ),
  deleteProviderModel: (providerId: string, mid: number) =>
    req<void>(`/api/providers/${providerId}/models/${mid}`, {
      method: "DELETE",
    }),

  // transform library (for the per-model transform editor)
  listTransforms: () => req<TransformDefInfo[]>("/api/transforms"),

  // users
  listUsers: () => req<User[]>("/api/users"),
  createUser: (input: Partial<User>) =>
    req<User>("/api/users", json("POST", input)),
  updateUser: (id: string, input: Partial<User>) =>
    req<User>(`/api/users/${id}`, json("PUT", input)),
  deleteUser: (id: string) =>
    req<void>(`/api/users/${id}`, { method: "DELETE" }),

  // api keys
  listApiKeys: () => req<ApiKey[]>("/api/api-keys"),
  createApiKey: (input: {
    name?: string | null;
    userId?: string | null;
    tokensPerDay?: number | null;
  }) => req<ApiKey>("/api/api-keys", json("POST", input)),
  updateApiKey: (
    id: string,
    input: {
      name?: string | null;
      userId?: string | null;
      tokensPerDay?: number | null;
      enabled?: boolean;
    },
  ) => req<ApiKey>(`/api/api-keys/${id}`, json("PUT", input)),
  deleteApiKey: (id: string) =>
    req<void>(`/api/api-keys/${id}`, { method: "DELETE" }),
  revealApiKey: (id: string) =>
    req<{ keyFull: string }>(`/api/api-keys/${id}/reveal`),

  // usage + logs
  usage: () => req<UsageResponse>("/api/usage"),
  usageBreakdown: () =>
    req<{ rows: FullBreakdownRow[] }>("/api/usage/breakdown"),
  usageForKey: (id: string) =>
    req<{ rows: UsageBreakdownRow[] }>(`/api/usage/keys/${id}`),
  usageForModel: (model: string) =>
    req<{ model: string; rows: ModelResolutionRow[] }>(
      `/api/usage/models/${encodeURIComponent(model)}`,
    ),
  requestLogs: (params: Record<string, string | number | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params))
      if (v !== undefined && v !== "") qs.set(k, String(v));
    const q = qs.toString();
    return req<RequestLog[]>(`/api/request-logs${q ? `?${q}` : ""}`);
  },
  requestLogDetail: (id: number) =>
    req<RequestLogDetail>(`/api/request-logs/${id}/detail`),

  // settings
  getSettings: () => req<Settings>("/api/settings"),
  updateSettings: (input: Partial<Settings>) =>
    req<Settings>("/api/settings", json("PUT", input)),
  changePassword: (password: string) =>
    req<{ ok: boolean }>("/api/settings/password", json("POST", { password })),

  // maintenance
  rebuildUsage: (day?: string) =>
    req<{
      days: number;
      usageRows: number;
      breakdownRows: number;
      tokens: number;
    }>(
      `/api/maintenance/rebuild-usage${day ? `?day=${encodeURIComponent(day)}` : ""}`,
      json("POST"),
    ),
  clearLogs: (scope: "errors" | "all") =>
    req<{ removed: number; scope: string }>(
      `/api/maintenance/clear-logs?scope=${scope}`,
      json("POST"),
    ),
};
