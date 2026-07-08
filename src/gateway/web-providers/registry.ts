// Web provider registry.
//
// Maps a provider id -> factory. To add a new backend:
//   1. Implement SearchProvider in ./<name>.ts (a `create<Name>Provider`
//      factory that takes a WebProviderConfig).
//   2. Register it in PROVIDERS below.
// That's it — it's usable immediately via config `provider: "<name>"`.

import type {
  SearchProvider,
  WebProviderConfig,
  WebProviderFactory,
} from "./types";
import { createFirecrawlProvider } from "./firecrawl";
import { createBraveProvider } from "./brave";

// The one place providers are wired in. Add a line here to drop in a backend.
const PROVIDERS: Record<string, WebProviderFactory> = {
  firecrawl: createFirecrawlProvider,
  brave: createBraveProvider,
  // tavily: createTavilyProvider,
};

// Default provider when none is specified.
export const DEFAULT_PROVIDER = "firecrawl";

// List the registered provider ids (for UI dropdowns / validation).
export function listWebProviders(): string[] {
  return Object.keys(PROVIDERS);
}

export function isWebProvider(name: string): boolean {
  return name in PROVIDERS;
}

// Build a provider instance from config. Falls back to DEFAULT_PROVIDER when
// the requested id is unknown or blank, so a misconfiguration degrades to a
// working default rather than crashing the request.
export function getWebProvider(config: WebProviderConfig): SearchProvider {
  const id =
    config.provider && PROVIDERS[config.provider]
      ? config.provider
      : DEFAULT_PROVIDER;
  return PROVIDERS[id](config);
}
