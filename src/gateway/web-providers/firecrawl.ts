// Firecrawl web provider — search + fetch.
//
// Keyless by default (the public API works without a key from allowed IPs); an
// optional API key is sent when configured. Implements the SearchProvider
// contract so it's interchangeable with any other backend via the registry.
//
// Docs: https://docs.firecrawl.dev/  (v2 endpoints)
//   POST /v2/search  { query, limit, sources, scrapeOptions } -> { data: { web: [...] } }
//   POST /v2/scrape  { url, formats }                          -> { data: { markdown, metadata } }

import { requestJson } from "../http-json";
import type {
  FetchResult,
  SearchOptions,
  SearchProvider,
  SearchResult,
  WebProviderConfig,
} from "./types";

const DEFAULT_BASE = "https://api.firecrawl.dev";
const DEFAULT_TIMEOUT = 45_000;

export function createFirecrawlProvider(
  config: WebProviderConfig,
): SearchProvider {
  const base = (config.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT;
  const headers: Record<string, string> = config.apiKey
    ? { authorization: `Bearer ${config.apiKey}` }
    : {};

  async function search(
    query: string,
    opts: SearchOptions = {},
  ): Promise<SearchResult[]> {
    const limit = clamp(opts.limit ?? 5, 1, 20);
    const body: Record<string, unknown> = {
      query: String(query).slice(0, 500),
      limit,
      sources: ["web"],
    };
    if (opts.scrape) body.scrapeOptions = { formats: ["markdown"] };

    const res = await requestJson({
      url: `${base}/v2/search`,
      headers,
      body: JSON.stringify(body),
      timeoutMs,
    });
    if (res.status < 200 || res.status >= 300)
      throw new Error(
        `firecrawl search ${res.status}: ${res.text.slice(0, 300)}`,
      );

    const parsed = safeParse(res.text);
    const web = (parsed?.data?.web ?? parsed?.data ?? []) as unknown[];
    if (!Array.isArray(web)) return [];
    return web.slice(0, limit).map((rRaw) => {
      const r = (rRaw ?? {}) as Record<string, unknown>;
      return {
        title: str(r.title) || str(r.url) || "(untitled)",
        url: str(r.url),
        description: str(r.description),
        ...(str(r.markdown) ? { markdown: str(r.markdown) } : {}),
      };
    });
  }

  async function fetch(url: string): Promise<FetchResult> {
    const res = await requestJson({
      url: `${base}/v2/scrape`,
      headers,
      body: JSON.stringify({ url: String(url), formats: ["markdown"] }),
      timeoutMs,
    });
    if (res.status < 200 || res.status >= 300)
      throw new Error(
        `firecrawl scrape ${res.status}: ${res.text.slice(0, 300)}`,
      );

    const parsed = safeParse(res.text);
    const data = (parsed?.data ?? {}) as Record<string, unknown>;
    const meta = (data.metadata ?? {}) as Record<string, unknown>;
    return {
      url: str(meta.sourceURL) || String(url),
      title: str(meta.title) || String(url),
      markdown: str(data.markdown),
      ...(typeof meta.statusCode === "number"
        ? { statusCode: meta.statusCode }
        : {}),
    };
  }

  return { name: "firecrawl", search, fetch };
}

function safeParse(
  text: string,
): { data?: Record<string, unknown> & { web?: unknown } } | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}
