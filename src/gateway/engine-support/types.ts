// Pure types for ForwardingEngine's internal routing/attempt plumbing — no
// `this`-bound logic, so they live apart from the class in engine.ts.

import type {
  ApiKey,
  Model,
  ModelTransformConfig,
  Provider,
} from "../../types";
import type { ProviderAdapter } from "../../providers";
import type {
  RequestTransform,
  ResponseTransform,
  StreamTransform,
  TransformCtx,
} from "../../formats/pipeline";

// The three wire formats the gateway understands.
export type Fmt = "chat" | "messages" | "responses";

// One resolved hop in a model's fallback chain: the provider to try, the
// upstream model id, its endpoint, plus the effective per-hop context window
// (link override ?? imported-model base) and the imported model's transforms.
//
// familyTransforms/ownTransforms are kept SEPARATE (rather than pre-merged)
// so buildRoute can place them on opposite sides of the adapter's own
// transform stack: builtin -> family defaults -> adapter -> model's own
// overrides. familyTransforms already excludes any entry ownTransforms
// overrides by (id, phase) — see dropOverriddenDefaults.
export interface ChainEntry {
  provider: Provider;
  upstreamModel: string;
  endpoint: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  familyTransforms: ModelTransformConfig[];
  ownTransforms: ModelTransformConfig[];
}

// Per-attempt route plan: where to send + the ordered transform stages (format
// conversion + any adapter-custom transforms) for request, response and stream.
// Built by buildRoute from the provider adapter + formats/pipeline.
export interface Route {
  forwardPath: string;
  endpointKind: Fmt;
  providerFmt: Fmt;
  clientFmt: Fmt;
  convert: boolean;
  /** Ordered request-body stages (client -> provider), then custom. */
  request: RequestTransform[];
  /** Ordered buffered-response stages (provider -> client), then custom. */
  response: ResponseTransform[];
  /** Ordered SSE stages (format bridge, then custom). */
  stream: StreamTransform[];
  /** True when a format-level stream bridge is present (for the unsupported check). */
  streamBridged: boolean;
  /** Context passed to every transform. */
  xctx: TransformCtx;
  unsupported?: string;
  /** Adapter that builds the outbound request for this hop (phase 2). */
  adapter: ProviderAdapter;
}

export interface ForwardContext {
  clientPath: string;
  requestBody: Record<string, unknown>;
  resolvedModel: Model | null;
  alias: string;
  apiKey: ApiKey | null;
  inputTokens: number;
  /** Tokens the pipeline optimistically debited from the key's daily counter
   *  (input estimate + reserved max output). Settlement reverses exactly this,
   *  then applies the actual usage — see settleUsage(). */
  reservedTokens: number;
  isStream: boolean;
  client: string | null;
  /** When true, capture distilled request/response payloads for the debug view.
   *  Read once per request from settings.debugLogging. */
  debug: boolean;
  /** Short correlation id for this request, set only when debug logging is on.
   *  When present it enables the per-transformation trace and ties the trace,
   *  attempts, and the final summary line together. */
  reqId?: string;
  /** Distilled client request JSON, computed once when debug is on. */
  debugRequest?: string | null;
  /** Web-tools config; when enabled, requests carrying the hosted web_search /
   *  web_fetch tools are handled by the gateway's loop against the selected
   *  web provider (see ./web-providers). */
  webTools?: {
    enabled: boolean;
    provider: string; // registry id, e.g. "firecrawl"
    baseUrl: string;
    apiKey: string;
  };
}

export interface AttemptResult {
  committed: boolean;
  /** True when a streaming attempt will settle usage + log itself once its
   *  pipeline ends; the caller must not settle/log again. */
  deferred?: boolean;
  status?: number;
  inputTokens?: number;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  /** Distilled response JSON (debug capture) from the buffered path. */
  debugResponse?: string | null;
  reason?: string;
  error?: string | null;
  /** Hash of the upstream key used, so forward() can record its health. */
  keyHash?: string | null;
  /** Immutable masked snapshot of the selected upstream credential. */
  keyMask?: string | null;
  /** Cooldown (ms) parsed from a 429 response's standard rate-limit headers. */
  rateLimitMs?: number;
  /** Absolute epoch ms when a rate-limited key should be usable again. */
  rateLimitResetAt?: number;
  /** Header/source used to derive rateLimitMs (retry-after, ratelimit-reset, etc.). */
  rateLimitSource?: string;
  /** Whether a 429 blocks the key globally or only one model class. */
  rateLimitScope?: "global" | "model";
  /** Model class affected when rateLimitScope is "model" (currently "fable"). */
  rateLimitModelClass?: string;
  /** Operator-facing explanation of the chosen cooldown scope. */
  rateLimitReason?: string;
}

// Upstream-reported usage shape (subset of readResponseUsage's return).
export interface StreamUsageLike {
  input?: number;
  output?: number;
  cached?: number;
}
