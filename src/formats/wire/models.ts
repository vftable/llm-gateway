// Wire types for the model-list endpoints (GET /v1/models).
//
// Two RAW upstream shapes exist in the wild — the parse targets of the
// fetchModelList() primitive:
//
//   OpenAI    { object:"list", data:[{ id, object:"model", created, owned_by }] }
//   Anthropic { data:[{ id, type:"model", display_name, created_at,
//               max_input_tokens, max_tokens, capabilities }], has_more, … }
//
// Only the fields the gateway reads are typed; an index signature keeps the rest
// of each payload intact for passthrough. The adapter seam normalizes BOTH into
// one universal `UpstreamModel` (below) so callers never branch on dialect.

import type { ModelCapabilities } from "../../types";

// --- OpenAI ( /v1/models ) ---------------------------------------------------
export interface OpenAIModel {
  id: string;
  object: "model";
  /** Unix timestamp (seconds) the model was created. */
  created: number;
  /** Organization that owns the model. */
  owned_by: string;
  [k: string]: unknown;
}

export interface OpenAIModelList {
  object: "list";
  data: OpenAIModel[];
  [k: string]: unknown;
}

// --- Anthropic ( /v1/models ) ------------------------------------------------
export interface AnthropicModel {
  id: string;
  type: "model";
  /** Human-readable name, e.g. "Claude Opus 4.6". */
  display_name: string;
  /** RFC 3339 datetime the model was released. */
  created_at: string;
  /** Max input context window in tokens (0/absent when unknown). */
  max_input_tokens?: number;
  /** Max value for the max_tokens parameter (0/absent when unknown). */
  max_tokens?: number;
  /** Anthropic-style capability listing (same shape the gateway exposes). */
  capabilities?: ModelCapabilities;
  [k: string]: unknown;
}

export interface AnthropicModelList {
  data: AnthropicModel[];
  /** Pagination cursors (Anthropic returns these; OpenAI does not). */
  has_more?: boolean;
  first_id?: string | null;
  last_id?: string | null;
  [k: string]: unknown;
}

// --- Universal descriptor ----------------------------------------------------
// The standardized, dialect-agnostic model the adapter seam returns. Superset of
// both wire shapes (Anthropic is the richer source, and maps trivially down to an
// OpenAI-type client). Only `id` is guaranteed; every other field is filled when
// the upstream reports it and left `undefined` otherwise, so a default OpenAI
// provider yields `{ id, created }` while a rich provider yields the whole shape.
export interface UpstreamModel {
  /** Upstream model id (what gets sent as the model parameter). */
  id: string;
  /** Human label, e.g. "Claude Opus 4.6". */
  displayName?: string;
  /** Max input context window in tokens. */
  contextWindow?: number;
  /** Max output tokens. */
  maxOutputTokens?: number;
  /** ISO-8601 creation/release date. */
  created?: string;
  /** Anthropic-style capability listing (omitted when the upstream has none). */
  capabilities?: ModelCapabilities;
  /** The original upstream entry, verbatim — for power users / debugging. */
  raw?: Record<string, unknown>;
}
