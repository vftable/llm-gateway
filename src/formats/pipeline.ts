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
import { ThinkingConverter } from "./thinking";
import {
  messagesRequestToChat,
  chatRequestToMessages,
  chatResponseToMessages,
  messagesResponseToChat,
  ChatToMessagesSseTransform,
  MessagesToChatSseTransform,
} from "./anthropic/bridge";
import {
  ResponsesBridge,
  StreamingResponsesBridgeTransform,
} from "./openai/responses";
import { SseThinkingTransform } from "./openai/streaming";
import { AnthropicThinkingTransform } from "./anthropic/streaming";

// The three wire formats the gateway understands. Canonical definition; the
// engine and provider adapters use this same union.
export type WireFmt = "chat" | "messages" | "responses";

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
}

// A named body transform for the (buffered) request or response path.
export interface RequestTransform {
  name: string;
  apply: (body: Json, ctx: TransformCtx) => Json;
}
export interface ResponseTransform {
  name: string;
  apply: (body: Json, ctx: TransformCtx) => Json;
}
// A named SSE stage for the streaming path.
export interface StreamTransform {
  name: string;
  create: (ctx: TransformCtx) => Transform;
}

// Adapter-supplied custom stages, appended after the built-in format stages.
export interface AdapterTransforms {
  request?: RequestTransform[];
  response?: ResponseTransform[];
  stream?: StreamTransform[];
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

// Request: from -> to.
export function reqConverter(from: WireFmt, to: WireFmt): BodyXform | null {
  if (from === to) return identity;
  if (from === "messages" && to === "chat") return messagesRequestToChat;
  if (from === "chat" && to === "messages") return chatRequestToMessages;
  if (from === "responses" && to === "chat")
    return (b) => responsesRequestToChat(b);
  return null;
}

// Non-streaming response: from -> to.
export function respConverter(from: WireFmt, to: WireFmt): BodyXform | null {
  if (from === to) return identity;
  if (from === "chat" && to === "messages") return chatResponseToMessages;
  if (from === "messages" && to === "chat") return messagesResponseToChat;
  if (from === "chat" && to === "responses")
    return (b) => responsesResponseFromChat(b);
  return null;
}

// Streaming response bridge factory: providerFmt -> clientFmt SSE transform.
export function streamBridgeFactory(
  from: WireFmt,
  to: WireFmt,
): (() => Transform) | null {
  if (from === to) return null;
  if (from === "chat" && to === "messages")
    return () => new ChatToMessagesSseTransform();
  if (from === "messages" && to === "chat")
    return () => new MessagesToChatSseTransform();
  if (from === "chat" && to === "responses")
    return () => new StreamingResponsesBridgeTransform();
  return null;
}

// Lazily-bound wrappers around ResponsesBridge (module-singleton to avoid
// per-request allocation).
const responsesBridgeSingleton = new ResponsesBridge();
function responsesRequestToChat(b: Json): Json {
  return responsesBridgeSingleton.requestToChatCompletions(b);
}
function responsesResponseFromChat(b: Json): Json {
  const r = responsesBridgeSingleton.responseFromChatCompletions(b);
  return (r ?? b) as Json;
}

// --- thinking helpers ------------------------------------------------------

// Extract <thinking> blocks in the PROVIDER format (mutates body in place).
export function applyThinking(
  conv: ThinkingConverter,
  fmt: WireFmt,
  body: Json,
): void {
  try {
    if (fmt === "chat") conv.applyToChatCompletion(body as never);
    else if (fmt === "messages") conv.applyToAnthropicMessage(body as never);
    else if (fmt === "responses") conv.applyToResponse(body as never);
  } catch {
    /* leave body untouched on transform error */
  }
}

// Pick the streaming thinking transform for a provider format. Returns null
// when there's no streaming thinking transform (e.g. responses).
export function thinkingStream(fmt: WireFmt): NodeJS.ReadWriteStream | null {
  if (fmt === "chat") return new SseThinkingTransform();
  if (fmt === "messages") return new AnthropicThinkingTransform();
  return null;
}

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

// Compose the ordered transform stages for one attempt.
//
// - `overrides` lets a bespoke adapter replace a built-in format converter
//   (e.g. a provider whose response shape is almost-but-not-quite standard).
// - `extra` are the adapter's custom stages, appended after the format stage so
//   they see the body already in the client's target shape (response/stream) or
//   still in the client's source shape before conversion is applied? See order
//   note below.
//
// Order:
//   request  = [ format(client->provider), ...extra.request ]
//   response = [ format(provider->client), ...extra.response ]
//   stream   = [ format bridge(provider->client), ...extra.stream ]
// Thinking extraction is applied by the engine on the PROVIDER-shape body/stream
// *before* the response/stream format stage (it must read provider-native
// fields), so it is not part of these arrays.
// Optional observer, invoked once per non-identity stage as the plan is
// composed. Lets the engine log the declared pipeline without formats/ importing
// the logger. dir is "req" | "resp" | "stream".
export type StageObserver = (dir: string, name: string) => void;

export function buildTransformPlan(
  clientFmt: WireFmt,
  plan: {
    forwardPath: string;
    providerFmt: WireFmt;
    reqTransform?: BodyXform;
    respTransform?: BodyXform;
    streamBridge?: () => Transform;
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
  const reqFn = plan.reqTransform ?? (convert ? reqConverter(clientFmt, providerFmt) : identity);
  // Response stage: provider -> client.
  const respFn = plan.respTransform ?? (convert ? respConverter(providerFmt, clientFmt) : identity);
  // Stream bridge: provider -> client (null when no conversion needed).
  const bridge =
    plan.streamBridge ?? (convert ? streamBridgeFactory(providerFmt, clientFmt) : null);

  if (convert && (!reqFn || !respFn)) {
    return {
      ...base,
      unsupported: `gateway cannot convert ${clientFmt} <-> ${providerFmt}`,
    };
  }

  if (reqFn && reqFn !== identity)
    base.request.push(fmtStage(`format:${clientFmt}->${providerFmt}`, reqFn));
  base.request.push(...(extra.request ?? []));

  if (respFn && respFn !== identity)
    base.response.push(fmtStage(`format:${providerFmt}->${clientFmt}`, respFn));
  base.response.push(...(extra.response ?? []));

  if (bridge)
    base.stream.push({
      name: `stream:${providerFmt}->${clientFmt}`,
      create: () => bridge(),
    });
  base.stream.push(...(extra.stream ?? []));

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
