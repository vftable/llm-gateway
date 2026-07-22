// Anthropic /v1/messages/count_tokens — a real upstream token count, used to
// pre-flight the ONE model that needs it: Claude Code Sonnet 4.6.
//
// Sonnet 4.6 on a Claude Code subscription is served only up to its BASE 200k
// context window; a longer prompt is refused upstream. (Opus 4.6 1M and the
// other models don't share this ceiling.) So before sending a Sonnet-4.6 request
// to a claude-code provider, the engine counts the input tokens here and, if
// it's over the window, skips that provider and fails over to one that can serve
// the long context. Everything is a plain callable function — no adapter seam.

import { requestJson } from "../../gateway/http";
import { agentFor } from "../../gateway/proxy-agent";
import { SONNET_46_RE } from "../../formats/model-version";

// Sonnet 4.6's base context window (input-token ceiling on a Claude Code sub).
export const SONNET_46_BASE_WINDOW = 200_000;

// The only top-level fields /v1/messages/count_tokens accepts. We send the SAME
// model/messages/system/tools/thinking as the real request so the count matches
// what would be billed; other keys (max_tokens, stream, metadata, …) are dropped
// — count_tokens 400s on some of them.
const COUNT_TOKENS_KEYS = [
  "model",
  "messages",
  "system",
  "tools",
  "thinking",
  "context_management",
  "output_config",
] as const;

// The input-token ceiling to enforce for a (catalogId, upstreamModel, url), or
// null when this hop isn't gated. Gated ONLY for Claude Code Sonnet 4.6 routing
// through the Messages endpoint (count_tokens lives at /v1/messages/count_tokens;
// a cross-format hop to /chat/completions has nothing to pre-flight).
export function contextWindowLimit(
  catalogId: string | null | undefined,
  upstreamModel: string,
  url: string,
): number | null {
  if (catalogId !== "claude-code") return null;
  if (!SONNET_46_RE.test(upstreamModel)) return null;
  if (!url.includes("/messages")) return null;
  return SONNET_46_BASE_WINDOW;
}

// Derive the /v1/messages/count_tokens URL from a /v1/messages URL, inserting
// `/count_tokens` after the `/messages` segment while preserving any query
// string (`?beta=true`). Returns the input unchanged when the path isn't a
// Messages endpoint or already points past it.
export function countTokensUrl(url: string): string {
  const messagesIdx = url.indexOf("/messages");
  if (messagesIdx === -1) return url;
  const endpoint = messagesIdx + "/messages".length;
  const head = url.slice(0, endpoint); // ".../v1/messages"
  const tail = url.slice(endpoint); // "?beta=true" | "" | "/..."
  if (tail && !tail.startsWith("?")) return url;
  return `${head}/count_tokens${tail}`;
}

// Trim a Messages request body down to the fields count_tokens accepts.
export function buildCountTokensBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of COUNT_TOKENS_KEYS) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

export interface CountInputTokensOpts {
  /** The real request's upstream URL (…/v1/messages[?beta=true]). */
  url: string;
  /** The real request's headers (auth + anthropic-version + OAuth beta). A
   *  content-length, if present, is dropped — the count body has its own. */
  headers: Record<string, string>;
  /** The real request's built body — trimmed to the count_tokens fields here. */
  body: Record<string, unknown>;
  timeoutMs?: number;
  tlsVerify?: boolean;
  /** Outbound proxy URL for this provider (same transport as the real request). */
  proxy?: string | null;
}

// POST to /v1/messages/count_tokens and return the counted input tokens, or
// null when the count is inconclusive (network error, non-2xx, unparseable
// response). Never throws — a null result means "couldn't tell, proceed".
export async function countInputTokens(
  opts: CountInputTokensOpts,
): Promise<number | null> {
  const url = countTokensUrl(opts.url);
  const headers: Record<string, string> = { ...opts.headers };
  delete headers["content-length"];
  try {
    const res = await requestJson({
      url,
      headers,
      body: JSON.stringify(buildCountTokensBody(opts.body)),
      timeoutMs: opts.timeoutMs,
      tlsVerify: opts.tlsVerify,
      agent: agentFor(opts.proxy, new URL(url).protocol === "https:"),
    });
    if (res.status < 200 || res.status >= 300) return null;
    const parsed = JSON.parse(res.text) as { input_tokens?: unknown };
    const n = parsed.input_tokens;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
