// Shared context/result types for the adapter builder scheme — the shapes
// BuildCtx/UsageCtx/TestModelCtx/ModelsCtx and their return values, plus the
// small ResolveUrl/ResolvePath composer types. Split out from adapter.ts so
// url.ts/models.ts can depend on them without importing the (much larger)
// ProviderAdapter class.

import {
  WireKind,
  type Provider,
  type ProviderKeyUsageWindow,
  type ModelTransformConfig,
} from "../../types";
import type {
  OpenAIModelList,
  AnthropicModelList,
} from "../../formats/wire/models";

// The three wire formats the gateway understands. Identical to the endpoint
// vocabulary `WireKind` (types/provider) — re-exported here as `WireFmt` for the
// engine-facing code that already speaks in "formats".
export type WireFmt = WireKind;

// Phase 1 — the routing decision for one inbound endpoint. `endpointKind` is the
// wire kind this hop routes through (the engine turns it into a path via
// endpointPathFor); `providerFmt` is the upstream's wire format (the engine
// converts client -> providerFmt — same value as the kind). `forwardPath` is the
// resolved path (filled by the engine from the kind, or set directly by a bespoke
// route). `unsupported` makes the engine skip to the next provider.
export interface EndpointRoute {
  endpointKind: WireFmt;
  providerFmt: WireFmt;
  forwardPath: string;
  unsupported?: string;
}

// A URL composer handed to build/model methods so an adapter NEVER calls
// `new URL()` or hand-concatenates. `resolve()` returns the full upstream URL:
//   - resolve()            → the current hop's path (origin + basePath + path)
//   - resolve("chat")      → a specific wire kind's path
//   - resolve("/foo/bar")  → a literal path appended to origin + basePath
export type ResolveUrl = (target?: WireKind | string) => string;

// A narrower composer for contexts with no wire-kind concept at all (UsageCtx —
// a usage report isn't a chat/messages/responses completion, so there's no kind
// to resolve a path for). Same origin+basePath composition, minus the WireKind
// branch, so the type signature can't imply a capability that isn't there.
export type ResolvePath = (target?: string) => string;

// Phase 2 — everything a build method sees. `body` has already been converted to
// `providerFmt` by the pipeline; edit it freely. `apiKey` is the key the proxy's
// key-health logic selected for this attempt (null when the provider has none).
// `url` + `headers` are the engine's composed defaults (origin+basePath+path and
// the standard header set with auth already applied) — a verbatim provider
// returns them untouched.
export interface BuildCtx {
  provider: Provider;
  /** Upstream model id being sent to this provider (the chain hop). */
  model: string;
  /** Request body, already in the provider's wire format — mutable. */
  body: Record<string, unknown>;
  /** API key selected by the proxy key-health logic (null = none). */
  apiKey: string | null;
  clientFmt: WireFmt;
  providerFmt: WireFmt;
  /** The wire kind this hop routes through. */
  endpointKind: WireFmt;
  forwardPath: string;
  /** Provider origin (no trailing slash concerns) — for building custom URLs. */
  baseUrl: string;
  /** Path prefix between origin and endpoint path (may be ""). */
  basePath: string;
  /** Compose a full upstream URL without `new URL()`; see ResolveUrl. */
  resolve: ResolveUrl;
  /** Default composed upstream URL (= resolve() for this hop). */
  url: string;
  /** Default header set (client passthrough + auth + extraHeaders). */
  headers: Record<string, string>;
}

// What a build method returns — any field may be rewritten by a bespoke provider.
export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

// Everything a keyUsage() implementation sees — parallel to BuildCtx. The adapter
// gets the provider, the SELECTED KEY (raw, so it can query the provider's own
// usage endpoint), a masked form for anything user-facing, an `enabled` flag, and
// a deterministic seed for stable placeholder data. keyUsage() is async so a real
// implementation can `await` an HTTP call; the caller awaits it. `resolve`/
// `request` are the SAME shape as TestModelCtx's, minus any wire-schema typing —
// a usage report is a provider-specific endpoint with its own arbitrary response
// shape, not a chat/messages/responses completion, so there's no WireRequest to
// build through a wire-format build method here. `request` still goes through
// the provider's proxy/TLS-aware transport, same as every other outbound probe.
export interface UsageCtx {
  provider: Provider;
  /** Raw API key for this row — use it to query the provider's usage endpoint. */
  apiKey: string;
  /** Masked key (head…tail) — safe for logs/labels; never surface the raw key. */
  mask: string;
  /** Whether this key is operator-enabled (false = disabled, still reported). */
  enabled: boolean;
  /** Stable per-key seed for deterministic placeholder windows. */
  seed: number;
  /** Provider origin — for building a custom usage-endpoint URL. */
  baseUrl: string;
  /** Path prefix between origin and any endpoint path (may be ""). */
  basePath: string;
  /** Compose a URL: no arg = origin+basePath only; a raw string is appended. */
  resolve: ResolvePath;
  /** Send a request through the provider's proxy/TLS-aware transport — an
   *  arbitrary JSON body/response, no wire schema (a usage endpoint has its own
   *  provider-specific shape). */
  request: AdapterRequest;
  /** Abort/timeout signal, forwarded to the transport. */
  signal?: AbortSignal;
}

// What keyUsage() returns.
//   - `windows`   the token/request/credit limits over time (empty when none).
//   - `dummy`     optional; DEFAULT false. Set true only for placeholder/estimate
//                 data (e.g. the demo generator) so the UI can badge it.
//   - `unavailable` optional; set true when the provider can't report usage for
//                 this key (no usage endpoint, or a live query failed).
//   - `message`   optional free-text note for the key (e.g. "Trial tier",
//                 "Rate limited until 3pm", or an error detail).
export interface KeyUsageResult {
  windows: ProviderKeyUsageWindow[];
  dummy?: boolean;
  unavailable?: boolean;
  message?: string;
}

// A minimal HTTP response `ctx.request()` resolves with — just enough for a
// testModel()/keyUsage() override to check status and read a body, parsed or
// raw. Shared by TestModelCtx and UsageCtx so both seams offer the identical
// request shape.
export interface AdapterHttpResponse {
  status: number;
  ok: boolean;
  /** Wall-clock time the request took, in ms. */
  ms: number;
  /** Raw response body text. */
  text: string;
  /** Parse `text` as JSON; throws if it isn't. */
  json(): unknown;
}

// The raw HTTP primitive `ctx.request()` sends through — a proxy/TLS-aware
// GET/POST, so an adapter override never touches Node's http/https or worries
// about the provider's `proxy`/`tlsVerify` settings itself. The route injects a
// real implementation (backed by the same transport fetchModels() uses); tests
// can swap in a fake one. Arbitrary JSON body, no wire-schema attached — used
// as-is for a provider's own (non-completion) endpoints, e.g. a usage report or
// a bespoke health check. A completion probe against ctx.model should go
// through `probeEndpoint()` instead, which types the body to a wire schema and
// runs it through this adapter's own build method first.
export type AdapterRequest = (
  url: string,
  init: {
    method?: "GET" | "POST";
    headers: Record<string, string>;
    body?: unknown;
    signal?: AbortSignal;
  },
) => Promise<AdapterHttpResponse>;

// Everything a testModel() implementation sees — parallel to BuildCtx/UsageCtx.
// `model` is the specific upstream id being probed (one imported-model row, NOT
// the whole provider) — a per-adapter test should send the smallest possible
// real request to THIS model (e.g. a 1-token completion) so a green result
// means "this exact id is reachable and answers", not just "the provider's
// base URL responds".
//
// Deliberately NOT pre-resolved to a wire kind/endpoint — there is no generic
// "the provider's native endpoint" here; only the adapter subclass knows which
// kind (chat/messages/responses) it actually wants to test with. The easy path
// for almost every override is `probeEndpoint(ctx, kind, body)` (see
// ProviderAdapter) — pick the kind, hand it a body typed to THAT kind's own
// request schema (ChatCompletionRequest / AnthropicMessagesRequest /
// ResponsesRequest — inferred from `kind` via WireRequest<K>), and it runs the
// body through this adapter's OWN requestTransforms(), then this adapter's OWN
// build method (chatCompletions/messages/responses — so custom auth/envelopes/
// signed URLs are exercised exactly like a real request), then sends it via
// `ctx.request()` and applies this adapter's OWN responseTransforms() to a
// successful reply. `resolve`/`request` remain here directly for a provider
// whose test truly can't be expressed as a typed completion body.
export interface TestModelCtx {
  provider: Provider;
  /** Upstream model id to test (a single imported ProviderModel's upstreamId). */
  model: string;
  /** Provider origin — for building a custom request URL. */
  baseUrl: string;
  /** Path prefix between origin and endpoint path (may be ""). */
  basePath: string;
  /** Compose a URL: no arg = origin+basePath only; a WireKind resolves that
   *  kind's path (via endpointPathFor); a raw string is used as-is. */
  resolve: ResolveUrl;
  /** `resolve()` with no argument — origin + basePath, no endpoint path. */
  url: string;
  /** Default header set (auth + extraHeaders) already applied. */
  headers: Record<string, string>;
  /** Raw API key selected for this query (null when the provider has none). */
  apiKey: string | null;
  /** Send a request through the provider's proxy/TLS-aware transport. Prefer
   *  `probeEndpoint()` for a completion probe; use this directly only for a
   *  genuinely bespoke check. */
  request: AdapterRequest;
  /** Abort/timeout signal, forwarded to the transport. */
  signal?: AbortSignal;
  /** Set by the route (only when `settings.debugLogging` is on) so
   *  `probeEndpoint()` prints the same per-stage XFORM trace a real request
   *  gets — both the declared plan (`dir` + stage `name`, "stream" included
   *  though probeEndpoint never actually applies a stream stage) and each
   *  request/response stage's actual application (`changed`). Undefined = no
   *  tracing (the default — zero cost). A bespoke testModel() override that
   *  skips probeEndpoint() and calls `ctx.request()` directly can call this
   *  itself around any applyBodyTransforms() it runs, for parity. */
  logStage?: (
    dir: "req" | "resp" | "stream",
    name: string,
    changed?: boolean,
  ) => void;
  /** The specific imported model's own transform config (its ProviderModel
   *  row's `transforms`), when probing an already-imported model — lets
   *  `probeEndpoint()` compose the FULL stack a live request would run
   *  (builtin defaults -> family defaults -> adapter -> this), not just the
   *  adapter's own transforms. Omit for a probe with no imported-model
   *  context (there is none to layer on). */
  ownTransforms?: ModelTransformConfig[];
}

// What testModel() returns — deliberately mirrors the shape of a real proxied
// response (status + a data payload) rather than a bare pass/fail, so the UI
// can show exactly what the model said (or the upstream's own error body).
//   - `ok`     true only when the model answered successfully.
//   - `status` the HTTP status the upstream returned (null if the request
//              never got a response — network error, timeout).
//   - `data`   on success: whatever the adapter wants to surface (a distilled
//              reply, e.g. { text, latencyMs }). On failure: the upstream's own
//              error body / message, verbatim where possible, so the operator
//              sees the REAL error rather than a generic "test failed".
//   - `ms`     wall-clock time the probe took, for the UI's latency badge.
export interface TestModelResult {
  ok: boolean;
  status: number | null;
  data: unknown;
  ms: number;
}

// Everything a testProvider() implementation sees — parallel to TestModelCtx,
// but PROVIDER-scoped rather than one-model-scoped: this is the "Test
// connection" button (provider detail's Overview tab, and the per-key Test
// button in the Keys tab), which checks the provider/key pair is reachable at
// all, not any one specific upstream model. Unlike testModel() — whose
// generic default is an inert dummy stub, because there is no sane
// provider-agnostic guess at "reachable" for a chat completion — testProvider()
// DOES have a universally sane default: every provider in this catalog serves
// a model-list endpoint (`baseUrl+basePath+modelsPath`), so the base class
// default is a real GET against it (see ProviderAdapter.testProvider). A
// bespoke provider overrides this only when connectivity means something
// other than "the model-list endpoint answers" — e.g. a dedicated health
// endpoint, or (see example-custom.ts) a deterministic synthetic success for
// a provider that has no real network dependency to check at all.
export interface TestProviderCtx {
  provider: Provider;
  /** Provider origin — for building a custom request URL. */
  baseUrl: string;
  /** Path prefix between origin and endpoint path (may be ""). */
  basePath: string;
  /** Compose a URL: no arg = the provider's model-list endpoint (the DEFAULT
   *  target); a WireKind resolves that kind's path; a raw string is used as-is. */
  resolve: ResolveUrl;
  /** `resolve()` with no argument — the default target the base
   *  implementation probes (origin + basePath + modelsPath). */
  url: string;
  /** Default header set (auth for `apiKey` + extraHeaders) already applied. */
  headers: Record<string, string>;
  /** The RAW key this test attempt sends — resolved by the caller (either the
   *  live rotation/health pick, or an operator-pinned specific key from the
   *  per-key Test button), never chosen by the adapter itself. Null only when
   *  the provider has no keys configured at all. */
  apiKey: string | null;
  /** Send a request through the provider's proxy/TLS-aware transport. */
  request: AdapterRequest;
  /** Abort/timeout signal, forwarded to the transport. */
  signal?: AbortSignal;
}

// What testProvider() returns. Mirrors TestModelResult's philosophy (surface
// the REAL outcome, not a bare pass/fail) with two provider-level additions:
//   - `sample`  a short snippet of the raw response body — diagnostic context
//               for a failure (e.g. the upstream's own error JSON), trimmed
//               so it's never a wall of text in the UI.
//   - `keyMask` filled in by the CALLER (the route), not the adapter — the
//               adapter never sees anything but the raw key it was handed, so
//               masking happens once, centrally, right before the result
//               reaches the response (see provider-probe.ts's testProvider).
export interface TestProviderResult {
  ok: boolean;
  status: number | null;
  ms: number;
  error?: string;
  sample?: string;
  keyMask?: string;
}

// The two model-list DIALECTS the gateway understands. This is narrower than
// WireFmt on purpose: /models has only two real shapes in the wild — OpenAI's
// ({ data:[{ id, owned_by }] }) and Anthropic's ({ data:[{ id, display_name }],
// has_more }). Both "chat" and "responses" wire formats speak the OpenAI dialect.
export type ModelsFormat = "openai" | "anthropic";

// Default value for the `anthropic-version` header, required by Anthropic's REST
// API (including GET /v1/models). Callers can override per request.
export const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

// The model-list dialect a wire format speaks: only Anthropic Messages uses the
// Anthropic shape; chat + responses both use OpenAI's.
export function modelsFormatOf(fmt: WireFmt): ModelsFormat {
  return fmt === "messages" ? "anthropic" : "openai";
}

// A minimal GET response — the subset of the Fetch `Response` fetchModelList()
// needs. A custom transport returns this shape without building a full Response.
export interface ModelListResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}

// The HTTP-GET transport fetchModelList() dispatches through. The DEFAULT is a
// thin wrapper over global fetch; the admin route injects a proxy/TLS-aware one so
// a provider's `proxy` + `tlsVerify` settings are honored (global fetch can't do
// SOCKS proxies or per-request rejectUnauthorized). Swappable in tests too.
export type ModelListTransport = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<ModelListResponse>;

// Options for the standalone fetchModelList() primitive — deliberately minimal and
// transport-agnostic so ANY url + ANY headers can be pointed at it. Only `url` is
// required; `format` defaults to "openai" (the common case). When `format` is
// "anthropic" the `anthropic-version` header is added automatically (unless the
// caller already set one, or overrode it via `anthropicVersion`).
export interface FetchModelListOptions {
  /** Fully-composed URL to GET. No path is assumed or appended. */
  url: string;
  /** Which dialect to parse/return as. Default "openai". */
  format?: ModelsFormat;
  /** Extra request headers (auth, etc.). Merged over sensible defaults. */
  headers?: Record<string, string>;
  /** Override the anthropic-version header (format:"anthropic" only). */
  anthropicVersion?: string;
  /** Abort/timeout signal, forwarded to the transport. */
  signal?: AbortSignal;
  /** HTTP transport override (default: global fetch). */
  transport?: ModelListTransport;
}

// Everything a fetchModels() implementation sees — parallel to BuildCtx/UsageCtx.
// The endpoint is COMPOSED BY THE CALLER from provider config (origin + basePath +
// modelsPath) and handed in on `url`, so no adapter hardcodes a "/v1/models" path;
// a bespoke provider whose model list lives elsewhere just rewrites `url`. Headers
// already carry the provider's auth. `apiKey` is the raw selected key (for a custom
// auth scheme); it never leaves the backend. `format` is the dialect to fetch in,
// pre-resolved from the provider's wire format (override it to fetch in the other).
export interface ModelsCtx {
  provider: Provider;
  /** Provider origin — for building a custom model-list URL. */
  baseUrl: string;
  /** Path prefix between origin and path (may be ""). */
  basePath: string;
  /** Model-discovery path (origin + basePath + modelsPath). */
  modelsPath: string;
  /** Compose a full URL without `new URL()`; resolve() = the models URL. */
  resolve: ResolveUrl;
  /** Composed model-list URL (= resolve()) — convenience for the common case. */
  url: string;
  /** Default header set (auth + extraHeaders) already applied. */
  headers: Record<string, string>;
  /** Raw API key selected for this query (null when the provider has none). */
  apiKey: string | null;
  /** Dialect to fetch + parse in ("openai" | "anthropic"). */
  format: ModelsFormat;
  /** Override the anthropic-version header (format:"anthropic" only). */
  anthropicVersion?: string;
  /** Abort/timeout signal, forwarded to the request. */
  signal?: AbortSignal;
  /** HTTP transport (default: global fetch; the route injects proxy/TLS-aware). */
  transport?: ModelListTransport;
}

// The RAW parse result of fetchModelList(): the model list TAGGED with the dialect
// it was parsed as (`openai` → { data:[{ id, owned_by }] }; `anthropic` →
// { data:[{ id, display_name, … }] }). A discriminated union — switch on `format`
// to narrow `list`. This is the low-level shape; adapters normalize it into the
// universal `UpstreamModel[]` (see normalizeModels) before returning.
export type ModelsResult =
  | { format: "openai"; list: OpenAIModelList }
  | { format: "anthropic"; list: AnthropicModelList };
