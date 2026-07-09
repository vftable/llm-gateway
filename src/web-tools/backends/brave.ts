// Brave Search web provider — search only (no page fetch).
//
// Best fit for interactive, latency-sensitive agents (Claude Code): Brave runs
// its own fresh index and has a generous free "Data for AI" tier. Requires an
// API key (get one on the Free AI plan at api-dashboard.search.brave.com).
//
// We request `extra_snippets=true` so each hit carries up to 5 extra excerpts —
// folded into the description so the agentic-loop path has richer context to
// reason over, while the short-circuit path still just uses title + URL.
//
// Docs: https://api-dashboard.search.brave.com/app/documentation/web-search
//   GET /res/v1/web/search?q=...&count=...&extra_snippets=true
//     headers: X-Subscription-Token, Accept: application/json
//   -> { web: { results: [ { title, url, description, age?, extra_snippets? } ] } }

import { requestJson } from "../../gateway/http";
import type {
  SearchOptions,
  SearchProvider,
  SearchResult,
  WebProviderConfig,
} from "./types";

const DEFAULT_BASE = "https://api.search.brave.com";
const DEFAULT_TIMEOUT = 20_000;
const MAX_DESC = 1_500; // cap merged description length per result

export function createBraveProvider(config: WebProviderConfig): SearchProvider {
  const base = (config.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT;

  async function search(
    query: string,
    opts: SearchOptions = {},
  ): Promise<SearchResult[]> {
    if (!config.apiKey)
      throw new Error("brave search requires an API key (webProviderApiKey)");

    const limit = clamp(opts.limit ?? 5, 1, 20);
    const params = new URLSearchParams({
      q: String(query).slice(0, 400),
      count: String(limit),
      extra_snippets: "true",
    });

    const res = await requestJson({
      url: `${base}/res/v1/web/search?${params.toString()}`,
      method: "GET",
      headers: {
        accept: "application/json",
        "x-subscription-token": config.apiKey,
      },
      timeoutMs,
    });
    if (res.status < 200 || res.status >= 300)
      throw new Error(`brave search ${res.status}: ${res.text.slice(0, 300)}`);

    const parsed = safeParse(res.text);
    const results = parsed?.web?.results;
    if (!Array.isArray(results)) return [];

    return results.slice(0, limit).map((rRaw) => {
      const r = (rRaw ?? {}) as Record<string, unknown>;
      // Merge the main snippet + extra excerpts into one description so the
      // reasoning model sees richer context; the short-circuit path only
      // surfaces title + url anyway.
      const parts = [str(r.description)];
      if (Array.isArray(r.extra_snippets)) {
        for (const s of r.extra_snippets) if (str(s)) parts.push(str(s));
      }
      const description = parts.filter(Boolean).join(" … ").slice(0, MAX_DESC);
      return {
        title: str(r.title) || str(r.url) || "(untitled)",
        url: str(r.url),
        description,
      };
    });
  }

  // Brave is search-only — no `fetch`. executeWebTool reports web_fetch as
  // unsupported for this provider rather than crashing.
  return { name: "brave", search };
}

function safeParse(text: string): { web?: { results?: unknown } } | null {
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
