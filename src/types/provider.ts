// Provider — an upstream LLM endpoint the gateway routes to, plus the wire-format
// and endpoint vocabulary shared across routing.

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
  /**
   * Path prefix inserted between the origin and each endpoint suffix, e.g.
   * "/v1beta/openai" for Google Gemini's OpenAI-compat surface. Empty string
   * (the default) means endpoints are full paths appended to the origin as-is,
   * preserving legacy behavior. The upstream URL is `origin + basePath + suffix`.
   */
  basePath: string;
  /**
   * Path used for upstream model discovery / connectivity test, joined as
   * `origin + basePath + modelsPath`. Defaults to "/v1/models".
   */
  modelsPath: string;
  /**
   * Outbound proxy URL for requests to this provider (socks5://…, socks5h://…,
   * http://…, https://…). null = direct connection.
   */
  proxy: string | null;
  /** ISO-3166 alpha-2 country tag for this provider (UI flag only; never routes). */
  country: string | null;
  /** Endpoints this provider accepts. With basePath set these are suffixes. */
  endpoints: string[];
  /**
   * When true, the provider accepts EITHER format and converts internally
   * (e.g. LiteLLM/9router). The gateway then forwards the client's request
   * unchanged to the client's original path. When false, the gateway converts
   * the client's request to the link's endpoint format itself.
   */
  nativeConversion: boolean;
  /**
   * Id of the catalog template this provider was created from (e.g. "nvidia-nim",
   * "openai-compatible"), or null for providers created before the catalog / by
   * config sync. Drives the browser's brand icon + label; never affects routing.
   */
  catalogId: string | null;
  createdAt: string;
  updatedAt: string;
}
