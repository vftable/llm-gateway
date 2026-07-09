// Web providers: pluggable search/fetch backends for the hosted web tools.
// See ./types for the SearchProvider contract and ./registry to add a backend.

export type {
  FetchResult,
  SearchOptions,
  SearchProvider,
  SearchResult,
  WebProviderConfig,
  WebProviderFactory,
} from "./types";
export {
  getWebProvider,
  listWebProviders,
  isWebProvider,
  DEFAULT_PROVIDER,
} from "./registry";
