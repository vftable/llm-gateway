// Model — a gateway-exposed alias with an ordered provider fallback chain.

import type { ModelCapabilities } from "./capabilities";

export interface ModelProviderLink {
  providerId: string;
  providerName: string | null;
  upstreamModel: string;
  priority: number;
  enabled: boolean;
  /** Endpoint to route this model through on this provider. */
  endpoint: string | null;
  /**
   * Per-hop override of the referenced imported model's context window. When set
   * and a request would exceed it, the engine skips this hop and falls through
   * to the next provider in the chain (safe fallback). null = use the imported
   * model's base / the exposed model's window.
   */
  contextWindow: number | null;
  /** Per-hop override of max output tokens. null = inherit. */
  maxOutputTokens: number | null;
}

export interface Model {
  id: string;
  alias: string;
  displayName: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  enabled: boolean;
  responsesNative: boolean;
  type: string;
  capabilities: ModelCapabilities;
  /**
   * True when the alias matches an official Anthropic model: capabilities are
   * pinned to the stock Anthropic entry and edits to them are ignored.
   */
  capabilitiesLocked: boolean;
  providers: ModelProviderLink[]; // ordered fallback chain
  createdAt: string;
  updatedAt: string;
  /** Per-alias pricing rates (null when no rates configured). */
  pricing: {
    promptPer1m: number | null;
    completionPer1m: number | null;
    cachedPer1m: number | null;
  } | null;
}
