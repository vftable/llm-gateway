// Shared OpenAI Codex backend protocol constants + helpers.
//
// Mirrors the layout used for Cline (../clinefree.ts): plain, dependency-light
// definitions consumed by BOTH the stock catalog adapter (./catalog/openai-codex.ts)
// and the managed-auth integration (services/provider-auth/integrations/codex.ts),
// so client-identity values have exactly one home.
//
// Everything here replicates the official Codex CLI's outbound behavior
// (openai/codex codex-rs sources):
//   - default_client.rs      : originator + user-agent defaults
//   - model-provider-info    : version header + CHATGPT_CODEX_BASE_URL
//   - bearer_auth_provider.rs: Authorization + ChatGPT-Account-Id headers
//   - endpoint/models.rs     : GET /models?client_version=...

import os from "os";
import { createHash } from "crypto";
import type { UpstreamModel } from "../formats/wire/models";

export const CODEX_API_BASE_URL = "https://chatgpt.com";
export const CODEX_BASE_PATH = "/backend-api/codex";
export const CODEX_MODELS_URL = `${CODEX_API_BASE_URL}${CODEX_BASE_PATH}/models`;
// Server-side exchange of a pasted browser session cookie for OAuth tokens.
export const CHATGPT_SESSION_URL = `${CODEX_API_BASE_URL}/api/auth/session`;
// OAuth token endpoint used for refresh_token grants (codex-rs login manager).
export const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
// Personal-access-token identity lookup (codex-rs auth/personal_access_token.rs
// PROD_AUTHAPI_BASE_URL + WHOAMI_PATH). A PAT has no JWT claims to decode, so
// this is the only way to resolve its account/plan/email - the same shape
// `codex login --with-access-token`/PersonalAccessTokenAuth::load() uses.
export const OPENAI_WHOAMI_URL =
  "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami";
// Codex CLI's public OAuth client id - required by the refresh grant.
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
// DEFAULT_ORIGINATOR from codex-rs default_client.rs - the originator header
// value and user-agent prefix.
export const CODEX_ORIGINATOR = "codex_cli_rs";
// Browser cookie whose VALUE is exchanged at CHATGPT_SESSION_URL. Only the
// value is ever handled server-side; the cookie itself is never stored.
export const CHATGPT_SESSION_COOKIE_NAME = "__Secure-next-auth.session-token";
// Codex CLI browser-login OAuth: localhost callback + issuer (see codex-rs
// login/server.rs - DEFAULT_PORT 1455, authorize at auth.openai.com).
export const CODEX_LOGIN_PORT = 1455;
export const CODEX_REDIRECT_URI = `http://localhost:${CODEX_LOGIN_PORT}/auth/callback`;
export const OPENAI_OAUTH_ISSUER = "https://auth.openai.com";
export const CODEX_OAUTH_SCOPE = "openid profile email offline_access";
// Browser-context User-Agent for the chatgpt.com/api/auth/session exchange.
// That endpoint is browser-facing behind Cloudflare; a Node/server UA makes a
// challenge near-certain even when valid clearance cookies ride along.
export const CHATGPT_BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
// Cloudflare SERVICE cookies that may accompany a pasted session-cookie line
// (allowlist mirrors codex-rs http-client/src/chatgpt_cloudflare_cookies.rs).
// They are replayed on the exchange request because chatgpt.com serves the
// session JSON only when prior challenge clearance rides along.
export const CLOUDFLARE_COOKIE_NAMES: readonly string[] = [
  "__cf_bm",
  "__cflb",
  "__cfruid",
  "__cfseq",
  "__cfwaitingroom",
  "_cfuvid",
  "cf_clearance",
  "cf_ob_info",
  "cf_use_ob",
];
export function isCloudflareCookieName(name: string): boolean {
  return CLOUDFLARE_COOKIE_NAMES.includes(name) || name.startsWith("cf_chl_");
}

// Pinned to the currently published @openai/codex npm version. This is the
// single bump point for the three CLI-version consumers: the version header,
// the user-agent version segment, and the models client_version query. The
// reqwest suffix is a SECOND, independent pin derived from codex-rs' Cargo.lock;
// recheck it separately whenever the upstream release changes.
export const CODEX_CLIENT_VERSION = "0.162.0";
// reqwest version pinned by codex-rs' Cargo.lock; the trailing segment of the
// CLI's User-Agent string.
export const CODEX_REQWEST_VERSION = "0.12.28";

// get_codex_user_agent(): "({os_type} {os_version}; {arch})". Preserve
// unmapped Node platform/architecture values instead of claiming Linux/x86_64.
export function codexOsSegment(
  platform: string = process.platform,
  release = os.release(),
  arch = os.arch(),
): string {
  const osTypes: Readonly<Record<string, string>> = {
    darwin: "Mac OS",
    win32: "Windows",
    linux: "Linux",
    freebsd: "FreeBSD",
    openbsd: "OpenBSD",
    sunos: "SunOS",
    aix: "AIX",
    android: "Android",
  };
  const architectures: Readonly<Record<string, string>> = {
    arm64: "arm64",
    x64: "x86_64",
    arm: "arm",
    ia32: "i686",
    ppc64: "powerpc64",
    s390x: "s390x",
    riscv64: "riscv64",
    loong64: "loongarch64",
  };
  const osType = Object.prototype.hasOwnProperty.call(osTypes, platform)
    ? osTypes[platform]
    : platform;
  const archName = Object.prototype.hasOwnProperty.call(architectures, arch)
    ? architectures[arch]
    : arch;
  return `${osType} ${release}; ${archName}`;
}

// codex-rs get_codex_user_agent():
//   "{originator}/{version} ({os_type} {os_ver}; {arch}) reqwest/{reqwest}"
export function codexUserAgent(): string {
  return `${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION} (${codexOsSegment()}) reqwest/${CODEX_REQWEST_VERSION}`;
}

// The client-identity headers every authenticated Codex backend request
// carries, minus Authorization/chatgpt-account-id which depend on the selected
// credential and ride along per-request.
export function codexIdentityHeaders(): Record<string, string> {
  return {
    originator: CODEX_ORIGINATOR,
    version: CODEX_CLIENT_VERSION,
    "user-agent": codexUserAgent(),
  };
}

// Full identity + auth header set for a specific Codex credential: identity
// headers, bearer Authorization, and chatgpt-account-id (the backend resolves
// subscription scope from it - requests without it fail).
export function codexRequestHeaders(
  accessToken: string,
  accountId?: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    ...extra,
    ...codexIdentityHeaders(),
    authorization: `Bearer ${accessToken}`,
    ...(accountId ? { "chatgpt-account-id": accountId } : {}),
  };
}

// Detect the ChatGPT-subscription usage-limit 429 body:
// { "error": { "type": "usage_limit_reached", "resets_in_seconds": N, ... } }
// Distinct from a normal rate limit - this is the account's 5h/weekly/monthly
// quota, so the cooldown must come from resets_in_seconds (no Retry-After or
// other rate-limit header rides along on this response at all).
export function isCodexUsageLimitError(body: string): boolean {
  return body.includes("usage_limit_reached");
}

// Derive the Codex prompt-cache affinity key for a request body.
//
// The ChatGPT Codex backend routes cache affinity off the request's
// `prompt_cache_key` (body) / `session-id` (header) pair - the official CLI
// always sends one (codex-rs core/src/client.rs: prompt_cache_key is Some(...)
// on every ResponsesApiRequest, and for root sessions the session-id header
// carries the SAME value). Without it each request lands on a random cache
// shard and multi-turn conversations re-pay the full uncached input price -
// the CLI-equivalent traffic shows ~80%+ cached tokens once the key sticks.
//
// The gateway has no CLI session, so the key is derived deterministically from
// the stable prefix of the conversation: the instructions plus the FIRST input
// item. That pair is identical across the turns of one conversation (history
// only ever appends) and differs across conversations, which is exactly the
// affinity grouping wanted. Formatted as a UUID so it is indistinguishable
// from the CLI's session-id-shaped keys.
export function codexPromptCacheKey(body: {
  instructions?: unknown;
  input?: unknown;
}): string {
  const first = Array.isArray(body.input) ? body.input[0] : undefined;
  const seed = JSON.stringify([
    typeof body.instructions === "string" ? body.instructions : "",
    first ?? null,
  ]);
  const digest = createHash("sha256").update(seed).digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    // RFC 4122 variant: force the top nibble to 8.
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

// Extract the account-quota reset delay straight from the JSON body -
// resets_in_seconds is the only reliable signal on this response (see
// isCodexUsageLimitError above). Returns undefined for anything unparsable so
// the caller can fall back to a generic default instead of a bogus cooldown.
export function codexRetryDelayMs(body: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const error = (parsed as { error?: unknown } | null)?.error;
  if (!error || typeof error !== "object") return undefined;
  const resetsInSeconds = (error as Record<string, unknown>).resets_in_seconds;
  if (typeof resetsInSeconds !== "number" || !Number.isFinite(resetsInSeconds))
    return undefined;
  if (resetsInSeconds <= 0) return undefined;
  return Math.round(resetsInSeconds * 1000);
}

// Parse + filter the Codex model catalog ({ models: [ModelInfo] }) down to
// PUBLIC API-usable entries: a non-empty slug, not opted out of the API
// (supported_in_api !== false), and visible (visibility absent or "list").
// Malformed entries are skipped silently; callers decide what empty means.
export function parseCodexModels(body: unknown): UpstreamModel[] {
  const models = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return [];
  const out: UpstreamModel[] = [];
  for (const raw of models) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.slug !== "string" || !entry.slug.trim()) continue;
    if (entry.supported_in_api === false) continue;
    const visibility =
      typeof entry.visibility === "string"
        ? entry.visibility.toLowerCase()
        : undefined;
    if (visibility && visibility !== "list") continue;
    out.push({
      id: entry.slug,
      displayName:
        typeof entry.display_name === "string" && entry.display_name.trim()
          ? entry.display_name
          : entry.slug,
      ...(typeof entry.context_window === "number" &&
      Number.isFinite(entry.context_window) &&
      entry.context_window > 0
        ? { contextWindow: entry.context_window }
        : {}),
      raw: entry,
    });
  }
  return out;
}
