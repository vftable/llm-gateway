// URL/path composition + auth-header helpers shared by the engine's outbound
// request builder and the admin model/probe helpers.

import { WireKind, type Provider, type AuthScheme } from "../../types";

// Apply a provider's API key to a header set per its auth scheme (mutates + returns
// `headers`). "bearer" → Authorization: Bearer; "xapikey" → x-api-key; "both" →
// both; "passthrough" (and a null/empty key) → nothing (the client's own auth is
// forwarded upstream). Single source for the auth branching the engine's outbound
// request builder and the admin model/probe helpers both need.
export function applyAuthHeaders(
  headers: Record<string, string>,
  authScheme: AuthScheme,
  key: string | null | undefined,
): Record<string, string> {
  if (!key) return headers;
  if (authScheme === "bearer" || authScheme === "both")
    headers["authorization"] = `Bearer ${key}`;
  if (authScheme === "xapikey" || authScheme === "both")
    headers["x-api-key"] = key;
  return headers;
}

// Compose origin + basePath + path by concatenation (not `new URL(path, base)`,
// which drops path prefixes). The single primitive both BuildCtx.resolve and
// ModelsCtx.resolve wrap. `path` and `basePath` should start with "/".
export function composeUrl(
  baseUrl: string,
  basePath: string,
  path: string,
): string {
  const origin = baseUrl.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : "/" + path;
  return origin + (basePath || "") + p;
}

// True when a path ends in one of the three canonical endpoint suffixes. Used to
// recognize a full path (vs a bare wire-kind) — migration + per-link parsing.
export function endsWithKnownSuffix(p: string): boolean {
  const x = p.split("?")[0];
  return (
    x.endsWith("/chat/completions") ||
    x.endsWith("/messages") ||
    x.endsWith("/responses")
  );
}

// The wire kind implied by an endpoint path suffix. The suffix IS the kind:
// /messages -> messages, /responses -> responses, /chat/completions -> chat.
// Returns `dflt` for a path with no recognized suffix.
export function wireFmtOf(path: string, dflt: WireKind): WireKind {
  const x = path.split("?")[0];
  if (x.endsWith("/messages")) return "messages";
  if (x.endsWith("/responses")) return "responses";
  if (x.endsWith("/chat/completions")) return "chat";
  return dflt;
}

// Coerce a value that may be EITHER a wire-kind ("chat") OR a legacy full path
// ("/v1/chat/completions") into a wire-kind. Tolerates the per-link `endpoint`
// column (historically a path) and the new enum uniformly.
export function wireKindOf(v: string, dflt: WireKind): WireKind {
  if (v === "chat" || v === "messages" || v === "responses") return v;
  return wireFmtOf(v, dflt);
}

// The STANDARD upstream path for a wire kind. With a basePath set, a bare suffix
// (joined onto origin+basePath); otherwise the full "/v1/…" path. This is the
// only place standard paths are spelled out.
export function standardPath(kind: WireKind, hasBasePath: boolean): string {
  const bare =
    kind === "messages"
      ? "/messages"
      : kind === "responses"
        ? "/responses"
        : "/chat/completions";
  return hasBasePath ? bare : "/v1" + bare;
}

// The upstream path for a provider + wire kind: a per-kind override when the
// provider declares one (non-standard layout), else the standard assembled path.
// Adapters and the engine call this instead of hand-spelling paths.
export function endpointPathFor(provider: Provider, kind: WireKind): string {
  const override = provider.endpointPaths?.[kind];
  if (override) return override.startsWith("/") ? override : "/" + override;
  return standardPath(kind, !!provider.basePath);
}

// Which wire KIND a hop routes through. Precedence:
//   1. explicit per-link endpoint (kind or legacy path) — an operator pin wins.
//   2. adapter `preferred` — a model-aware preference (e.g. GPT-5 -> responses),
//      honored only when the provider actually accepts that kind.
//   3. the provider's first declared endpoint kind.
//   4. the adapter's native kind.
// Path assembly is separate (endpointPathFor).
export function resolveKind(
  provider: Provider,
  nativeKind: WireKind,
  linkEndpoint: string | null,
  preferred?: WireKind,
): WireKind {
  if (linkEndpoint) return wireKindOf(linkEndpoint, nativeKind);
  if (preferred && provider.endpoints?.includes(preferred)) return preferred;
  const first = provider.endpoints?.[0];
  if (first) return first;
  return nativeKind;
}
