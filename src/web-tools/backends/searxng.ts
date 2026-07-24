// SearXNG web search provider — search only (no page fetch).
//
// SearXNG is a self-hosted meta-search engine with a free JSON API. No API key
// needed — just point baseUrl at a running instance.
//
// Docs: https://docs.searxng.org/dev/search_api.html
//   GET /search?format=json&q=...&safesearch=0
//   -> { results: [ { title, url, content, abstract } ] }

import { requestJson } from "../../gateway/http";
import type {
  SearchOptions,
  SearchProvider,
  SearchResult,
  WebProviderConfig,
} from "./types";

// No default baseUrl — the user MUST configure one (plan §Step 1).
const DEFAULT_BASE = "";
const DEFAULT_TIMEOUT = 20_000;

export function createSearxngProvider(
  config: WebProviderConfig,
): SearchProvider {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT;

  async function search(
    query: string,
    opts: SearchOptions = {},
  ): Promise<SearchResult[]> {
    const base = (config.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
    if (!base)
      throw new Error(
        "searxng search requires baseUrl (webProviderBaseUrl) — " +
          "point it at a self-hosted instance, e.g. http://localhost:8080",
      );

    const limit = clamp(opts.limit ?? 5, 1, 20);
    const params = new URLSearchParams({
      q: String(query),
      format: "json",
      safesearch: "0",
    });

    const url = new URL("/search", base);
    url.search = params.toString();

    const res = await requestJson({
      url: String(url),
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "llm-gateway/1.0",
      },
      timeoutMs,
    });
    if (res.status < 200 || res.status >= 300)
      throw new Error(
        `searxng search ${res.status}: ${res.text.slice(0, 300)}`,
      );

    const parsed = safeParse(res.text);
    const results = parsed?.results;
    if (!Array.isArray(results)) return [];

    return results.slice(0, limit).map((rRaw) => {
      const r = (rRaw ?? {}) as Record<string, unknown>;
      // Merge content (primary snippet) and abstract (alt snippet) into one
      // description, matching Brave's "merge snippet + extras" feel.
      const parts = [str(r.content), str(r.abstract)].filter(Boolean);
      const description = parts.join(" ");
      return {
        title: str(r.title) || str(r.url) || "(untitled)",
        url: str(r.url),
        description,
      };
    });
  }

  // SearXNG is search-only — no `fetch`. executeWebTool reports web_fetch as
  // unsupported for this provider rather than crashing.
  return { name: "searxng", search };
}

function safeParse(text: string): { results?: unknown } | null {
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
