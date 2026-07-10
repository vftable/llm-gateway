// Provider — an upstream LLM endpoint the gateway routes to, plus the wire-format
// and endpoint vocabulary shared across routing.

export type AuthScheme = "bearer" | "xapikey" | "both" | "passthrough";

export const AUTH_SCHEMES: AuthScheme[] = [
  "bearer",
  "xapikey",
  "both",
  "passthrough",
];

// What wire format a provider speaks natively. Drives the generic-adapter
// selection and how the gateway converts when the client speaks the other format.
export type ProviderFormat = "anthropic" | "openai";

export const PROVIDER_FORMATS: ProviderFormat[] = ["anthropic", "openai"];

// The three LLM request endpoints the gateway understands, named by KIND (not
// path). A provider declares which kinds it accepts (`endpoints`); the adapter
// assembles the actual URL path for each kind from the origin + basePath, with an
// optional per-kind override for non-standard layouts (`endpointPaths`). This is
// the single endpoint vocabulary — identical to the engine's WireFmt.
export type WireKind = "chat" | "messages" | "responses";

// Named members so code reads `WireKind.Chat` instead of the bare "chat" string
// (the type and this value-companion intentionally share a name). Prefer these in
// adapter templates and anywhere a kind is written by hand.
export const WireKind = {
  Chat: "chat",
  Messages: "messages",
  Responses: "responses",
} as const;

export const WIRE_KINDS: WireKind[] = [
  WireKind.Chat,
  WireKind.Messages,
  WireKind.Responses,
];

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  host: string | null;
  /** Active keys — rotated round-robin across requests. */
  apiKeys: string[];
  /** Keys toggled off by the operator: retained but skipped in selection. */
  disabledApiKeys: string[];
  authScheme: AuthScheme;
  extraHeaders: Record<string, string>;
  retryAttempts: number;
  retryIntervalMs: number;
  requestTimeoutMs: number;
  tlsVerify: boolean;
  enabled: boolean;
  /**
   * Generic-adapter selector for providers with NO catalogId: "anthropic" picks
   * the generic Anthropic adapter, "openai" (or null) the generic OpenAI one.
   * null when the provider is adapter-backed (catalogId set) or `nativeConversion`
   * is on — in both cases the format is derived/irrelevant, not stored. Never the
   * source of truth for an adapter's own format (that's the adapter's nativeFmt).
   */
  format: ProviderFormat | null;
  /**
   * Path prefix inserted between the origin and each endpoint path, e.g.
   * "/v1beta/openai" for Google Gemini's OpenAI-compat surface. Empty string
   * (the default) means the standard "/v1/…" paths are appended to the origin.
   * The upstream URL is `origin + basePath + endpointPath(kind)`.
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
  /**
   * Which endpoint KINDS this provider accepts (chat/messages/responses). The
   * adapter turns each kind into a URL path from origin+basePath; a non-standard
   * layout can override the path per kind via `endpointPaths`.
   */
  endpoints: WireKind[];
  /**
   * Optional per-kind path override for a non-standard layout that doesn't
   * warrant a full custom adapter (e.g. an upstream whose chat lives at
   * "/api/v2/chat"). Missing kinds use the standard assembled path. Rarely set.
   */
  endpointPaths: Partial<Record<WireKind, string>>;
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
