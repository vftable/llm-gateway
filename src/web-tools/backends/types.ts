// Web search/fetch provider abstraction.
//
// A "web provider" backs the gateway's hosted web_search / web_fetch tools with
// a real search engine (Firecrawl, Tavily, Brave, …). The gateway talks to a
// provider only through the SearchProvider interface, so swapping or adding a
// backend is a drop-in: implement SearchProvider and register it (see
// ./registry). No other code changes.

// One search hit, provider-agnostic. `markdown` is the optional full page body
// (only when the provider was asked to scrape).
export interface SearchResult {
  title: string;
  url: string;
  description: string;
  markdown?: string;
}

// One fetched page's readable content.
export interface FetchResult {
  url: string;
  title: string;
  markdown: string;
  statusCode?: number;
}

export interface SearchOptions {
  limit?: number; // max results (provider clamps to its own bounds)
  scrape?: boolean; // also pull full markdown per hit (slower/costlier)
}

// Runtime config handed to a provider factory. `provider` selects which backend;
// the rest are common knobs. Providers ignore fields they don't use.
export interface WebProviderConfig {
  provider: string; // registry id, e.g. "firecrawl"
  baseUrl?: string; // override the provider's default endpoint
  apiKey?: string | null; // optional; some providers are keyless
  timeoutMs?: number;
}

// The contract every web provider implements. `fetch` is optional — a provider
// that only does search can omit it (the gateway then reports web_fetch as
// unavailable rather than crashing).
export interface SearchProvider {
  /** Registry id (matches the key it was registered under). */
  readonly name: string;
  /** Run a web search. Throws on transport/API failure. */
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
  /** Fetch one URL's readable content as markdown. Optional. */
  fetch?(url: string): Promise<FetchResult>;
}

// A factory builds a provider instance from its runtime config.
export type WebProviderFactory = (config: WebProviderConfig) => SearchProvider;
