// The format transform pipeline — the one place cross-format conversion is
// declared, for both streaming and non-streaming responses.
//
// A request flows: client body --[request transforms]--> upstream body.
// A buffered response flows: upstream body --[response transforms]--> client body.
// A streamed response flows: upstream SSE --[stream transforms]--> client SSE.
//
// Each stage is a named transform. `buildTransformPlan` composes the ordered
// stages for a given (clientFmt -> providerFmt) pair from the built-in
// conversion tables, then appends any adapter-supplied custom transforms. To add
// custom logic for a provider you return extra transforms from its adapter
// (see providers/base.ts requestTransforms()/responseTransforms()/streamTransforms())
// — nothing here changes, and the transform runs identically streaming or not.

import type { Transform } from "stream";
import type { Provider } from "../types";
import {
  messagesRequestToChat,
  chatRequestToMessages,
  chatResponseToMessages,
  messagesResponseToChat,
  ChatToMessagesSseTransform,
  MessagesToChatSseTransform,
} from "./converters/chat-messages";
import {
  responsesRequestToChat,
  chatRequestToResponses,
  chatResponseToResponses,
  responsesResponseToChat,
  StreamingResponsesBridgeTransform,
  StreamingResponsesToChatBridgeTransform,
} from "./converters/chat-responses";
import { SseEventTransform } from "./sse/events";
import type {
  WireFmt,
  WireRequest,
  WireResponse,
  WireStreamEvent,
} from "./wire";

// The three wire formats the gateway understands, plus the shared wire types +
// format→type mappings, re-exported so an adapter author imports everything for
// authoring transforms from this one module. `WireFmt` (the canonical union; the
// engine and adapters use this same type) comes from wire/ via this re-export.
export * from "./wire";

export type Json = Record<string, unknown>;
export type BodyXform = (b: Json) => Json;

// Context handed to every transform, so a custom transform can branch on the
// provider, the formats in play, or the resolved model / chain hop.
export interface TransformCtx {
  provider: Provider;
  clientFmt: WireFmt;
  providerFmt: WireFmt;
  /** Exposed model alias this request resolved to (when known). */
  alias?: string;
  /** The upstream model id being sent to this provider (the chain hop). */
  upstreamModel?: string;
  /** Effective per-hop output-token ceiling (link ?? imported ?? model), for
   *  transforms that clamp max_tokens (e.g. the Anthropic max-tokens hook). */
  maxOutputTokens?: number | null;

  // --- request-side rewrite side-channel ------------------------------------
  // A REQUEST transform may rewrite the outbound URL + headers (not just the
  // body) by mutating these. The engine reads them back AFTER running the
  // request stages for an attempt: `headerOverrides` are merged into the default
  // header set (a null value deletes a header) and `urlOverride` replaces the
  // composed upstream URL, both BEFORE the adapter's build phase — so they form
  // the defaults the builder sees and may itself override. Freshly reset per
  // attempt so a rewrite can't leak across retries/hops.
  /** Header overrides a request hook wants applied (string sets, null deletes). */
  headerOverrides?: Record<string, string | null>;
  /** Full upstream URL a request hook wants used instead of the composed one. */
  urlOverride?: string;
}

// `label`/`blurb`/`group` are OPTIONAL display metadata on EVERY transform
// shape below (tagged and untagged alike) — never read by the engine or the
// pipeline itself, only surfaced by the read-only "resolved transforms"
// preview (src/admin/routes/resolved-transforms.ts, rendered by
// <DefaultTransformsPanel> in the web UI) so an operator sees a human name
// instead of the bare stage `name`. A stage with no `label` falls back to a
// humanized form of `name` in the UI; there is no requirement to set these —
// they exist purely for a friendlier display, matching the label/blurb every
// TransformDef in the user-configurable library already carries (see
// formats/transforms/registry.ts). `group` clusters multiple stages that
// always run together as one conceptual unit (e.g. the four Anthropic request
// hooks) under a single collapsible row in the UI instead of four separate
// ones — set the SAME `group` string on every stage that belongs together;
// stages with no `group` (or a `group` no sibling shares) render individually.
export interface TransformMeta {
  /** Short human-readable name, e.g. "Prompt-cache breakpoints". Falls back
   *  to a humanized `name` in the UI when omitted. */
  label?: string;
  /** One-line description of what the stage does, shown under its label. */
  blurb?: string;
  /** Clusters this stage with any sibling sharing the same `group` string
   *  under one collapsible UI row instead of showing each separately. */
  group?: string;
}

// A named body transform for the (buffered) request or response path.
export interface RequestTransform extends TransformMeta {
  name: string;
  apply: (body: Json, ctx: TransformCtx) => Json;
}
export interface ResponseTransform extends TransformMeta {
  name: string;
  apply: (body: Json, ctx: TransformCtx) => Json;
}
// A named SSE stage for the streaming path.
export interface StreamTransform extends TransformMeta {
  name: string;
  create: (ctx: TransformCtx) => Transform;
}

// ===========================================================================
// Tagged transforms — the typed, self-describing authoring API
// ===========================================================================
//
// A tagged transform declares:
//   - phase:  "request" (client→upstream) or "response" (upstream→client)
//   - format: which wire format it's written for (chat | messages | responses)
//
// The engine runs a tagged transform only at the pipeline point where the body
// is actually in its format (see buildTransformPlan's placement rule): a request
// tagged clientFmt runs pre-conversion; tagged providerFmt runs post-conversion;
// a response/stream tagged providerFmt runs pre-bridge; tagged clientFmt runs
// post-bridge. A tag matching neither format is skipped. Authors never do this
// bookkeeping — they call onRequest/onResponse/onStreamEvent with a format and a
// typed handler, and the engine places + type-erases everything.

export interface TaggedRequestTransform extends TransformMeta {
  name: string;
  phase: "request";
  format: WireFmt;
  apply: (body: Json, ctx: TransformCtx) => Json;
}
export interface TaggedResponseTransform extends TransformMeta {
  name: string;
  phase: "response";
  format: WireFmt;
  apply: (body: Json, ctx: TransformCtx) => Json;
}
export interface TaggedStreamTransform extends TransformMeta {
  name: string;
  phase: "response";
  format: WireFmt;
  create: (ctx: TransformCtx) => Transform;
}

// A request stage: either an untagged legacy transform (kept for model-config
// transforms, placed post-conversion) or a format-tagged one.
export type AnyRequestTransform = RequestTransform | TaggedRequestTransform;
export type AnyResponseTransform = ResponseTransform | TaggedResponseTransform;
export type AnyStreamTransform = StreamTransform | TaggedStreamTransform;

// --- typed authoring factories --------------------------------------------
//
// Infer the body/event type from the format tag so a handler edits the right
// typed shape. The runtime apply/create is type-erased to Json/Transform; the
// factory does the (safe) cast so the engine can treat every stage uniformly.

// A request transform for `format`. `apply` receives the typed request body for
// that format and returns it (mutate + return, or return a new object). `meta`
// is optional display-only info (label/blurb/group — see TransformMeta above);
// omit it freely, it has no effect on behavior.
export function onRequest<F extends WireFmt>(
  format: F,
  name: string,
  apply: (body: WireRequest<F>, ctx: TransformCtx) => WireRequest<F>,
  meta?: TransformMeta,
): TaggedRequestTransform {
  return {
    name,
    phase: "request",
    format,
    apply: (b, ctx) => apply(b as WireRequest<F>, ctx) as Json,
    ...meta,
  };
}

// A buffered-response transform for `format`. `apply` receives the typed
// response body for that format. `meta` — see onRequest.
export function onResponse<F extends WireFmt>(
  format: F,
  name: string,
  apply: (body: WireResponse<F>, ctx: TransformCtx) => WireResponse<F>,
  meta?: TransformMeta,
): TaggedResponseTransform {
  return {
    name,
    phase: "response",
    format,
    apply: (b, ctx) => apply(b as WireResponse<F>, ctx) as Json,
    ...meta,
  };
}

// A streaming-response transform for `format`. `handle` is called once per
// parsed SSE event with the typed event; return the (edited) event, or null to
// drop it. The SSE framing/parse/serialize is handled by SseEventTransform.
// `meta` — see onRequest.
export function onStreamEvent<F extends WireFmt>(
  format: F,
  name: string,
  handle: (
    event: WireStreamEvent<F>,
    ctx: TransformCtx,
  ) => WireStreamEvent<F> | null,
  meta?: TransformMeta,
): TaggedStreamTransform {
  return {
    name,
    phase: "response",
    format,
    create: (ctx) =>
      new SseEventTransform(
        format,
        (data, c) =>
          handle(data as WireStreamEvent<F>, c) as Record<
            string,
            unknown
          > | null,
        ctx,
      ),
    ...meta,
  };
}

// Adapter-supplied custom stages. Each array accepts untagged legacy transforms
// AND format-tagged ones; buildTransformPlan places them by tag (untagged keep
// the historical post-conversion / post-bridge placement).
export interface AdapterTransforms {
  request?: AnyRequestTransform[];
  response?: AnyResponseTransform[];
  stream?: AnyStreamTransform[];
}

// The composed plan that drives dispatch. `providerFmt` is the upstream's native
// format; `forwardPath` the suffix appended to origin+basePath. When
// `unsupported` is set the engine skips to the next provider in the chain.
export interface TransformPlan {
  forwardPath: string;
  providerFmt: WireFmt;
  request: RequestTransform[];
  response: ResponseTransform[];
  stream: StreamTransform[];
  unsupported?: string;
}

// ===========================================================================
// Built-in conversion tables (clientFmt <-> providerFmt)
// ===========================================================================

function identity(b: Json): Json {
  return b;
}

// A directed conversion key, e.g. "chat->messages". The three tables below are
// keyed by this so each supported pair is a single readable row and lookup is
// O(1). `from === to` (identity / no-bridge) is handled before the lookup.
type FmtPair = `${WireFmt}->${WireFmt}`;
const pair = (from: WireFmt, to: WireFmt): FmtPair => `${from}->${to}`;

// Request body converters, from -> to. Only the convertible pairs appear.
// responses<->messages has no DIRECT converter (Responses only ever bridges
// to/from Chat) — chatRequestToMessages/messagesRequestToChat compose with
// the responses<->chat pair below to cover it in two hops instead of
// duplicating the Responses<->Anthropic mapping from scratch.
const REQUEST_CONVERTERS: Partial<Record<FmtPair, BodyXform>> = {
  "messages->chat": messagesRequestToChat,
  "chat->messages": chatRequestToMessages,
  "responses->chat": (b) => responsesRequestToChat(b) as Json,
  "chat->responses": (b) => chatRequestToResponses(b) as Json,
  // messages -> responses: messages -> chat -> responses.
  "messages->responses": (b) =>
    chatRequestToResponses(messagesRequestToChat(b)) as Json,
  // responses -> messages: responses -> chat -> messages.
  "responses->messages": (b) =>
    chatRequestToMessages(responsesRequestToChat(b) as Json),
};

// Non-streaming response body converters, from -> to. chatResponseToResponses
// and responsesResponseToChat return null on a missing/malformed body (rather
// than throwing); `?? b` passes the original bytes through untouched in that
// case, same as every other converter's implicit contract.
const RESPONSE_CONVERTERS: Partial<Record<FmtPair, BodyXform>> = {
  "chat->messages": chatResponseToMessages,
  "messages->chat": messagesResponseToChat,
  "chat->responses": (b) => (chatResponseToResponses(b) as Json | null) ?? b,
  "responses->chat": (b) => (responsesResponseToChat(b) as Json | null) ?? b,
  // responses -> messages: responses -> chat -> messages.
  "responses->messages": (b) =>
    chatResponseToMessages((responsesResponseToChat(b) as Json | null) ?? b),
  // messages -> responses: messages -> chat -> responses.
  "messages->responses": (b) =>
    (chatResponseToResponses(messagesResponseToChat(b)) as Json | null) ?? b,
};

// Streaming SSE bridge CHAINS, providerFmt -> clientFmt. Each entry is an
// ORDERED list of Transform factories run as separate pipeline stages (the
// engine already pipes route.stream as a sequence — see streamConvert in
// engine.ts — so a two-hop bridge is just two stages, not a single composed
// Transform). Every direct pair is a one-element chain; responses<->messages
// is the two-element chain that reuses the chat<->messages and
// chat<->responses bridges instead of a bespoke responses<->messages SSE
// translator.
const STREAM_BRIDGES: Partial<Record<FmtPair, Array<() => Transform>>> = {
  "chat->messages": [() => new ChatToMessagesSseTransform()],
  "messages->chat": [() => new MessagesToChatSseTransform()],
  "chat->responses": [() => new StreamingResponsesBridgeTransform()],
  "responses->chat": [() => new StreamingResponsesToChatBridgeTransform()],
  "responses->messages": [
    () => new StreamingResponsesToChatBridgeTransform(),
    () => new ChatToMessagesSseTransform(),
  ],
  "messages->responses": [
    () => new MessagesToChatSseTransform(),
    () => new StreamingResponsesBridgeTransform(),
  ],
};

// Request: from -> to. `identity` when no conversion; null when unsupported.
export function reqConverter(from: WireFmt, to: WireFmt): BodyXform | null {
  if (from === to) return identity;
  return REQUEST_CONVERTERS[pair(from, to)] ?? null;
}

// Non-streaming response: from -> to.
export function respConverter(from: WireFmt, to: WireFmt): BodyXform | null {
  if (from === to) return identity;
  return RESPONSE_CONVERTERS[pair(from, to)] ?? null;
}

// Streaming response bridge CHAIN: providerFmt -> clientFmt, as an ordered
// list of Transform factories (usually one; responses<->messages is two).
// null when no bridge is needed (same format) or none exists.
export function streamBridgeChain(
  from: WireFmt,
  to: WireFmt,
): Array<() => Transform> | null {
  if (from === to) return null;
  return STREAM_BRIDGES[pair(from, to)] ?? null;
}

// Thinking extraction is no longer applied here — it's a format-tagged default
// (see formats/thinking + formats/transforms/defaults), placed
// pre-bridge by buildTransformPlan like any other tagged stage.

// ===========================================================================
// Plan composition
// ===========================================================================

// Wrap a built-in body converter as a named format-conversion stage.
function fmtStage(
  name: string,
  fn: BodyXform,
): RequestTransform & ResponseTransform {
  return { name, apply: (b) => fn(b) };
}

// Split a list of maybe-tagged stages into three buckets relative to the format
// conversion, given the format each side is in on each side of the bridge:
//   - pre:      tagged stages whose format == `preFmt` (run before conversion)
//   - post:     tagged stages whose format == `postFmt` (run after conversion)
//   - untagged: legacy stages with no format — always placed post (historical)
// A tagged stage matching neither format is dropped (its shape never occurs on
// this hop). Order within each bucket is preserved.
function splitByFormat<T extends object>(
  stages: T[],
  preFmt: WireFmt,
  postFmt: WireFmt,
): { pre: T[]; post: T[]; untagged: T[] } {
  const pre: T[] = [];
  const post: T[] = [];
  const untagged: T[] = [];
  for (const s of stages) {
    const fmt = (s as { format?: WireFmt }).format;
    if (typeof fmt !== "string") untagged.push(s);
    else if (fmt === preFmt) pre.push(s);
    else if (fmt === postFmt) post.push(s);
    // else: tagged for a format this hop never produces — skip.
  }
  return { pre, post, untagged };
}

// Compose the ordered transform stages for one attempt.
//
// `extra` are the pipeline's custom stages — thinking defaults, adapter
// transforms, and model-config transforms — each either format-tagged or
// untagged. Placement is by (phase, format) relative to the wire conversion:
//
//   request  (client → provider):
//     [ ...tagged==clientFmt,   format(client→provider), ...tagged==providerFmt, ...untagged ]
//   response (provider → client):
//     [ ...tagged==providerFmt, format(provider→client), ...tagged==clientFmt,   ...untagged ]
//   stream   (provider → client):
//     [ ...tagged==providerFmt, bridge(provider→client), ...tagged==clientFmt,   ...untagged ]
//
// So a stage sees the body in the shape it was written for: a request stage
// tagged the client format runs pre-conversion; tagged the provider format runs
// post-conversion. Untagged stages keep the historical post placement (model
// transforms). Thinking defaults are tagged the PROVIDER format, so they land in
// the pre-bridge response/stream slot — reading provider-native fields exactly
// as the old standalone applyThinking/thinkingStream did.
//
// Optional observer, invoked once per stage as the plan is composed. Lets the
// engine log the declared pipeline without formats/ importing the logger. dir is
// "req" | "resp" | "stream".
export type StageObserver = (dir: string, name: string) => void;

export function buildTransformPlan(
  clientFmt: WireFmt,
  plan: {
    forwardPath: string;
    providerFmt: WireFmt;
    unsupported?: string;
  },
  extra: AdapterTransforms = {},
  onStage?: StageObserver,
): TransformPlan {
  const { forwardPath, providerFmt } = plan;
  const base: TransformPlan = {
    forwardPath,
    providerFmt,
    request: [],
    response: [],
    stream: [],
  };
  if (plan.unsupported) return { ...base, unsupported: plan.unsupported };

  const convert = clientFmt !== providerFmt;

  // Request stage: client -> provider.
  const reqFn = convert ? reqConverter(clientFmt, providerFmt) : identity;
  // Response stage: provider -> client.
  const respFn = convert ? respConverter(providerFmt, clientFmt) : identity;
  // Stream bridge CHAIN: provider -> client (null when no conversion needed;
  // usually one factory, responses<->messages is two — see streamBridgeChain).
  const bridgeChain = convert
    ? streamBridgeChain(providerFmt, clientFmt)
    : null;

  if (convert && (!reqFn || !respFn)) {
    return {
      ...base,
      unsupported: `gateway cannot convert ${clientFmt} <-> ${providerFmt}`,
    };
  }

  // Request: client-shape stages, conversion, provider-shape stages, untagged.
  const req = splitByFormat(extra.request ?? [], clientFmt, providerFmt);
  base.request.push(...(req.pre as RequestTransform[]));
  if (reqFn && reqFn !== identity)
    base.request.push(fmtStage(`format:${clientFmt}->${providerFmt}`, reqFn));
  base.request.push(...(req.post as RequestTransform[]));
  base.request.push(...(req.untagged as RequestTransform[]));

  // Response: provider-shape stages, conversion, client-shape stages, untagged.
  const resp = splitByFormat(extra.response ?? [], providerFmt, clientFmt);
  base.response.push(...(resp.pre as ResponseTransform[]));
  if (respFn && respFn !== identity)
    base.response.push(fmtStage(`format:${providerFmt}->${clientFmt}`, respFn));
  base.response.push(...(resp.post as ResponseTransform[]));
  base.response.push(...(resp.untagged as ResponseTransform[]));

  // Stream: provider-shape stages, bridge (one stage per chain hop), client-
  // shape stages, untagged.
  const strm = splitByFormat(extra.stream ?? [], providerFmt, clientFmt);
  base.stream.push(...(strm.pre as StreamTransform[]));
  if (bridgeChain) {
    const multi = bridgeChain.length > 1;
    bridgeChain.forEach((factory, i) => {
      base.stream.push({
        name: multi
          ? `stream:${providerFmt}->${clientFmt}[${i + 1}/${bridgeChain.length}]`
          : `stream:${providerFmt}->${clientFmt}`,
        create: () => factory(),
      });
    });
  }
  base.stream.push(...(strm.post as StreamTransform[]));
  base.stream.push(...(strm.untagged as StreamTransform[]));

  if (onStage) {
    for (const t of base.request) onStage("req", t.name);
    for (const t of base.response) onStage("resp", t.name);
    for (const t of base.stream) onStage("stream", t.name);
  }

  return base;
}

// Apply an ordered list of body transforms, threading the context. A throwing
// transform aborts the chain (caller decides how to handle). `onApply` (when
// given) fires per stage with whether it changed the body — used for the
// per-transformation trace log.
export function applyBodyTransforms(
  transforms: Array<RequestTransform | ResponseTransform>,
  body: Json,
  ctx: TransformCtx,
  onApply?: (name: string, changed: boolean) => void,
): Json {
  let out = body;
  for (const t of transforms) {
    const next = t.apply(out, ctx);
    if (onApply) onApply(t.name, next !== out);
    out = next;
  }
  return out;
}
