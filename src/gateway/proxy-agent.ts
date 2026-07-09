// Outbound proxy agents. When a provider has a `proxy` URL set, upstream
// requests are dispatched through a SOCKS5 or HTTP(S) proxy instead of a direct
// connection. Agents are cached by (proxyUrl, https) so we don't rebuild one per
// request. When no proxy is set we return undefined so callers keep Node's
// default global agent (unchanged behavior).

import http from "http";
import https from "https";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";

type Agent = http.Agent | https.Agent;

const cache = new Map<string, Agent>();

// Returns an agent for the given proxy URL, or undefined for a direct
// connection. `proxyUrl` accepts socks5://, socks5h://, socks4://, http:// and
// https:// schemes. Throws only on a malformed URL; callers treat a throw as a
// bad-config attempt (surfaced as a failed request, not a crash).
export function agentFor(
  proxyUrl: string | null | undefined,
  isHttps: boolean,
): Agent | undefined {
  const url = (proxyUrl ?? "").trim();
  if (!url) return undefined;
  const cacheKey = `${isHttps ? "s" : "p"}:${url}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const scheme = url.slice(0, url.indexOf(":")).toLowerCase();
  let agent: Agent;
  if (scheme.startsWith("socks")) {
    agent = new SocksProxyAgent(url);
  } else if (scheme === "http" || scheme === "https") {
    // HttpsProxyAgent tunnels HTTPS via CONNECT and also proxies plain HTTP.
    agent = new HttpsProxyAgent(url);
  } else {
    throw new Error(`unsupported proxy scheme: ${scheme}`);
  }
  cache.set(cacheKey, agent);
  return agent;
}

// True when a proxy string looks usable (has a scheme we support). Used by the
// admin layer to validate before saving without constructing an agent.
export function isSupportedProxy(proxyUrl: string): boolean {
  const s = proxyUrl.trim().toLowerCase();
  return (
    s.startsWith("socks") ||
    s.startsWith("http://") ||
    s.startsWith("https://")
  );
}
