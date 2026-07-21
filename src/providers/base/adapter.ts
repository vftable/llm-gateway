// The ProviderAdapter builder scheme — a provider adapter owns BOTH a
// provider's catalog metadata (the data the Add-Provider wizard renders) AND
// its per-endpoint routing behavior. See ../base's former header comment
// (preserved in this folder's index.ts) for the two-phase route/build model.

import {
  WireKind,
  type Provider,
  type ProviderTemplate,
  type ProviderDefaults,
  type ProviderQuirks,
  type TemplateField,
  type ProviderKeyUsage,
  type ProviderKeyUsageWindow,
  type ProviderFormat,
} from "../../types";
import {
  buildTransformPlan,
  applyBodyTransforms,
  type AdapterTransforms,
  type AnyRequestTransform,
  type AnyResponseTransform,
  type AnyStreamTransform,
  type TransformCtx,
  type Json,
} from "../../formats/pipeline";
import { collectDefaults } from "../../formats/transforms/defaults";
import {
  modelTransformBags,
  dropOverriddenDefaults,
} from "../../formats/transforms";
import { ThinkingConverter } from "../../formats/thinking";
import type { UpstreamModel } from "../../formats/wire/models";
import type {
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ResponsesRequest,
  ResponsesResponse,
  WireRequest,
} from "../../formats/wire";
import { ORDERED_KEYS } from "../../formats/anthropic/hooks/sanitize-request";
import { limitAnthropicCacheControl } from "../../formats/anthropic/hooks/cache-control-limiter";
import { endpointPathFor, resolveKind } from "./url";
import { fetchModelList, normalizeModels, minimalProbeBody } from "./models";
import type {
  WireFmt,
  EndpointRoute,
  BuildCtx,
  BuiltRequest,
  UsageCtx,
  KeyUsageResult,
  TestModelCtx,
  TestModelResult,
  TestProviderCtx,
  TestProviderResult,
  ModelsCtx,
} from "./types";

export abstract class ProviderAdapter {
  constructor(protected readonly meta: ProviderTemplate) {}

  get id(): string {
    return this.meta.id;
  }
  get label(): string {
    return this.meta.label;
  }
  get brand(): string {
    return this.meta.brand;
  }
  get defaults(): ProviderDefaults {
    return this.meta.defaults;
  }
  get fields(): TemplateField[] {
    return this.meta.fields;
  }
  get quirks(): ProviderQuirks | undefined {
    return this.meta.quirks;
  }

  // BASE_URL for internal reference (the catalog default origin, "" when the
  // template ships none — e.g. the generic openai-compatible escape hatch).
  get baseUrl(): string {
    return this.meta.defaults.baseUrl ?? "";
  }

  // The provider's native wire kind. Subclasses set this ONCE — it's the single
  // source of the adapter's identity: the fallback kind when no endpoint pins
  // another, the base of `formats`, and (via nativeFormat) the generic-adapter
  // identity. A generic adapter never needs a stored `format` field.
  protected abstract get nativeFmt(): WireFmt;

  // The provider FORMAT this adapter speaks (anthropic vs openai dialect),
  // derived from its native wire kind. Lets a generic adapter identify itself
  // without a hardcoded/stored format.
  get nativeFormat(): ProviderFormat {
    return this.nativeFmt === WireKind.Messages ? "anthropic" : "openai";
  }

  // Wire kinds this provider supports: the declared endpoint kinds plus the
  // native kind (always included).
  get formats(): WireFmt[] {
    const set = new Set<WireFmt>([this.nativeFmt]);
    for (const e of this.meta.defaults.endpoints ?? []) set.add(e);
    return [...set];
  }

  // The plain metadata shape the API + wizard consume (unchanged contract).
  toTemplate(): ProviderTemplate {
    return this.meta;
  }

  // Model-aware endpoint preference: given the upstream model and the kinds the
  // provider accepts, return the kind this adapter would PREFER (or undefined for
  // "no preference"). A per-link endpoint pin still overrides this; it only steers
  // the default. Generic seam — e.g. OpenAI prefers /v1/responses for its newer
  // model families. Default: no preference.
  preferredEndpoint(
    _model: string,
    _accepted: WireKind[],
  ): WireKind | undefined {
    return undefined;
  }

  // --- phase 1: route --------------------------------------------------------
  // Decide the wire kind for a hop: a per-link endpoint wins, then the adapter's
  // model-aware preference (preferredEndpoint), then provider.endpoints[0], then
  // the native kind (see resolveKind). The engine assembles the actual path from
  // the kind (endpointPathFor). Override this only to change WHICH kind a hop
  // routes through; to change the request SHAPE or URL, override a build method.
  routeFor(
    _clientFmt: WireFmt,
    p: Provider,
    linkEndpoint: string | null,
    model = "",
  ): EndpointRoute {
    const preferred = linkEndpoint
      ? undefined
      : this.preferredEndpoint(model, p.endpoints);
    const endpointKind = resolveKind(
      p,
      this.nativeFmt,
      linkEndpoint,
      preferred,
    );
    return {
      endpointKind,
      providerFmt: endpointKind,
      forwardPath: endpointPathFor(p, endpointKind),
    };
  }

  // --- phase 2: build (the seam) ---------------------------------------------
  // One method per provider wire format. Called AFTER the body has been converted
  // to `ctx.providerFmt`. Override the one(s) your provider needs; the default
  // forwards the composed request verbatim. Full flexibility: rewrite ctx.url
  // (signed/custom host), ctx.headers (custom auth from ctx.apiKey), and ctx.body
  // (envelopes, extra fields) — return the final { url, headers, body }.
  chatCompletions(ctx: BuildCtx): BuiltRequest {
    return this.defaultBuild(ctx);
  }
  messages(ctx: BuildCtx): BuiltRequest {
    return this.defaultBuild(ctx);
  }
  responses(ctx: BuildCtx): BuiltRequest {
    return this.defaultBuild(ctx);
  }

  // Verbatim forward: the composed URL + headers + the converted body, untouched.
  protected defaultBuild(ctx: BuildCtx): BuiltRequest {
    return { url: ctx.url, headers: ctx.headers, body: ctx.body };
  }

  // Dispatch to the build method matching the provider's wire format (called by
  // the engine once conversion has produced the provider-shape body).
  buildFor(providerFmt: WireFmt, ctx: BuildCtx): BuiltRequest {
    if (providerFmt === WireKind.Messages) return this.messages(ctx);
    if (providerFmt === WireKind.Responses) return this.responses(ctx);
    return this.chatCompletions(ctx);
  }

  // --- custom transform hooks ------------------------------------------------
  // Override any of these in a provider file to inject extra pipeline stages.
  // Return format-tagged transforms authored with onRequest/onResponse/
  // onStreamEvent (typed to the wire format) — the engine places each by tag
  // relative to the wire conversion (see formats/pipeline buildTransformPlan).
  // Untagged transforms are also accepted (placed post-conversion, historical).
  // Default: no extra stages.
  //
  // Transforms edit the BODY as part of the conversion pipeline (before the build
  // phase). To rewrite URL/headers, use a build method instead.
  requestTransforms(_p: Provider): AnyRequestTransform[] {
    return [];
  }

  responseTransforms(_p: Provider): AnyResponseTransform[] {
    return [];
  }

  streamTransforms(_p: Provider): AnyStreamTransform[] {
    return [];
  }

  // Collected custom stages for this provider, consumed by buildTransformPlan.
  transforms(p: Provider): AdapterTransforms {
    return {
      request: this.requestTransforms(p),
      response: this.responseTransforms(p),
      stream: this.streamTransforms(p),
    };
  }

  // --- usage reporting -------------------------------------------------------
  // Upstream key-usage windows (token AND request quotas, over any time windows)
  // for the dashboard. Same seam philosophy as the build methods: the adapter is
  // handed everything it needs on a UsageCtx — the provider, the SELECTED KEY
  // (raw, for an upstream query), plus a masked form and a deterministic seed —
  // and returns the windows. It is ASYNC: an adapter with a real usage endpoint
  // does the HTTP request itself and the caller awaits it.
  //
  // The DEFAULT is honest: most providers expose no usage endpoint, so it reports
  // `unavailable` (the UI shows an "Unavailable" state, not fabricated bars). An
  // adapter with a real endpoint overrides this and returns windows; one that only
  // wants demo bars can return `{ windows: dummyUsageWindows(ctx.seed), dummy: true }`.
  //
  // The raw key never leaves the backend — the route masks before responding.
  async keyUsage(_ctx: UsageCtx): Promise<KeyUsageResult> {
    return {
      windows: [],
      unavailable: true,
      message: "This provider does not report key usage for your API key.",
    };
  }

  // Whether this adapter reports upstream key usage AT ALL — the visibility gate
  // for the usage dashboard. Same UsageCtx as keyUsage() (an adapter can decide
  // from provider config), but SYNC: it's a capability declaration, not a query,
  // so it must not touch the network.
  //
  //   - false (the DEFAULT) → the provider is HIDDEN from the dashboard. Most
  //     providers expose no usage endpoint, so their keyUsage() only ever returns
  //     "unavailable"; showing a card full of empty keys is noise, not signal.
  //   - true → the provider is SHOWN even if a live keyUsage() query later throws.
  //     That failure surfaces as an "unavailable" state + message on the affected
  //     KEY, without hiding the whole provider.
  //
  // An adapter that overrides keyUsage() with a real query should override this to
  // return true (see example-custom).
  supportsKeyUsage(_ctx: UsageCtx): boolean {
    return false;
  }

  // --- model discovery -------------------------------------------------------
  // Fetch the provider's model catalog (GET /models). Same seam philosophy as
  // keyUsage(): ASYNC and it does the HTTP request ITSELF (unlike the build
  // methods, which only shape a request the engine sends). The caller composes
  // the endpoint from provider config and hands it in on `ctx.url` — nothing here
  // hardcodes a path — so a bespoke provider overrides this to hit a different
  // URL, sign the request, or return a fully hand-built list.
  //
  // The return is the UNIVERSAL `UpstreamModel[]` — one dialect-agnostic shape
  // (id + optional displayName / contextWindow / maxOutputTokens / capabilities).
  // Callers never branch on openai-vs-anthropic. The DEFAULT fetches in the ctx's
  // dialect (fetchModelList auto-sets anthropic-version for Anthropic) and
  // normalizes; a rich provider overrides this and returns hand-built models
  // (see example-custom). Use modelIds(list) for a sorted id-only view.
  async fetchModels(ctx: ModelsCtx): Promise<UpstreamModel[]> {
    const result = await fetchModelList({
      url: ctx.url,
      headers: ctx.headers,
      format: ctx.format,
      anthropicVersion: ctx.anthropicVersion,
      signal: ctx.signal,
      transport: ctx.transport,
    });
    return normalizeModels(result);
  }

  // --- model testing ----------------------------------------------------------
  // Probe ONE imported model (ctx.model) to confirm it's actually reachable and
  // answers — the Imported Models table's per-row test action. Same seam
  // philosophy as fetchModels()/keyUsage(): ASYNC, and a real implementation
  // does the HTTP request itself. WHICH endpoint to test (chat/messages/
  // responses) is entirely this adapter's call — nothing generic decides it.
  // The easy path for almost every override is one line via `probeEndpoint()`:
  //
  //   async testModel(ctx: TestModelCtx) {
  //     return this.probeEndpoint(ctx, WireKind.Chat);
  //   }
  //
  // `probeEndpoint()` resolves that kind's URL (ctx.resolve(kind)), builds a
  // minimal one-token request body for it (minimalProbeBody — override with a
  // `body` option for a provider that needs a different shape), sends it via
  // `ctx.request()` (proxy/TLS-aware, same transport fetchModels() uses), and
  // wraps the response into TestModelResult — success/failure, status, timing,
  // and either a distilled reply or the upstream's own error body all handled.
  // A provider with genuinely bespoke needs (custom auth, a non-standard success
  // check, streaming) can skip probeEndpoint() and use ctx.request()/ctx.resolve()
  // directly instead — see example-custom.ts.
  //
  // DEFAULT is a dummy stub — no network call. It always reports success with
  // a placeholder body so the UI/wiring can be exercised end-to-end before any
  // adapter implements a real probe.
  async testModel(ctx: TestModelCtx): Promise<TestModelResult> {
    return {
      ok: true,
      status: 200,
      data: {
        dummy: true,
        message: `No live test wired for this provider yet — ${ctx.model} was not actually queried.`,
      },
      ms: 0,
    };
  }

  // The one-line path almost every testModel() override wants: pick `kind`
  // (chat/messages/responses — YOUR call, nothing generic infers it), hand it a
  // BODY TYPED TO THAT KIND's own request schema (WireRequest<K> — a
  // ChatCompletionRequest/AnthropicMessagesRequest/ResponsesRequest; default
  // `minimalProbeBody(kind, ctx.model)`, a real one-token request), and this:
  //
  //   1. runs the body through the FULL stack a live request to `kind` would
  //      apply — builtin all-provider defaults (Anthropic hooks, thinking),
  //      then this provider's FAMILY defaults (quirks.defaultTransforms,
  //      minus anything ctx.ownTransforms overrides), then THIS adapter's own
  //      requestTransforms(ctx.provider), then ctx.ownTransforms itself —
  //      same order, same buildTransformPlan/applyBodyTransforms machinery,
  //      that engine.ts's buildRoute composes for real traffic (see its own
  //      header comment). A provider with no family defaults and no adapter
  //      override (most OpenAI-family catalog entries) still gets the
  //      builtin layer, so its probe isn't silently empty,
  //   2. hands the transformed body to THIS adapter's own build method for `kind`
  //      (buildFor -> chatCompletions/messages/responses) — so bespoke auth,
  //      envelopes, or signed URLs are exercised for real, not bypassed,
  //   3. sends the built request via ctx.request() (proxy/TLS-aware),
  //   4. on success, runs the reply through the same full stack's response
  //      side, then `opts.summarize` (if given) distills it down to just what
  //      the operator needs (default: the raw parsed JSON). On failure, the
  //      upstream's own error body is returned untouched (transforms don't
  //      run on an error, same as a real request — see engine.ts's non-2xx
  //      path).
  //
  // The build methods (chatCompletions/messages/responses) never send anything
  // themselves — they only shape a request, exactly like a real hop. This
  // method is the one place that actually calls ctx.request().
  protected async probeEndpoint<K extends WireFmt>(
    ctx: TestModelCtx,
    kind: K,
    opts?: {
      body?: WireRequest<K>;
      summarize?: (json: unknown) => unknown;
    },
  ): Promise<TestModelResult> {
    const rawBody = opts?.body ?? minimalProbeBody(kind, ctx.model);

    // Step 1: compose the FULL stack a live request to `kind` would run —
    // same layering + order as engine.ts's buildRoute (builtin -> family ->
    // adapter -> model's own), same buildTransformPlan/applyBodyTransforms
    // machinery, so a custom transform (at any layer) is exercised here
    // exactly like it would be for live traffic. No client<->provider
    // conversion (kind IS the provider format here), just placement +
    // application. `ctx.logStage` (set by the route only when debug logging
    // is on) gets the declared plan AND each stage's actual application —
    // the same XFORM trace a real request produces.
    const defaults = collectDefaults({
      thinking: new ThinkingConverter(),
      providerFmt: kind,
    });
    const familyBag = modelTransformBags(
      dropOverriddenDefaults(this.quirks?.defaultTransforms, ctx.ownTransforms),
    );
    const adapterBag = this.transforms(ctx.provider);
    const ownBag = modelTransformBags(ctx.ownTransforms);
    const plan = buildTransformPlan(
      kind,
      { forwardPath: "", providerFmt: kind },
      {
        request: [
          ...defaults.request,
          ...familyBag.request,
          ...(adapterBag.request ?? []),
          ...ownBag.request,
        ],
        response: [
          ...defaults.response,
          ...familyBag.response,
          ...(adapterBag.response ?? []),
          ...ownBag.response,
        ],
        stream: [...defaults.stream, ...(adapterBag.stream ?? [])],
      },
      ctx.logStage
        ? (dir, name) => ctx.logStage!(dir as "req" | "resp" | "stream", name)
        : undefined,
    );
    // `headers` is a FRESH copy of ctx.headers (already carrying this
    // probe's auth header, applied by the route from the same ctx.apiKey —
    // see provider-probe.ts's makeTestModelCtx/modelsRequestHeaders) so a
    // request transform gets the exact same full-header-table control here
    // as it does on a live request (see TransformCtx.headers's doc comment):
    // it edits xctx.headers in place, and that — not the original ctx.headers
    // — is what reaches the build phase below. `apiKey` gives a transform the
    // raw key itself, matching what the build phase separately receives.
    const xctx: TransformCtx = {
      provider: ctx.provider,
      clientFmt: kind,
      providerFmt: kind,
      upstreamModel: ctx.model,
      apiKey: ctx.apiKey,
      keyMetadata: {},
      headers: { ...ctx.headers },
    };
    (rawBody as Json).model = ctx.model;
    const transformed = applyBodyTransforms(
      plan.request,
      rawBody as Json,
      xctx,
      ctx.logStage
        ? (name, changed) => ctx.logStage!("req", name, changed)
        : undefined,
    );

    // Step 2: this adapter's own build method for `kind` — never sends
    // anything itself, only shapes { url, headers, body }. Headers are
    // whatever the request transforms left in xctx.headers (edits included).
    const built = this.buildFor(kind, {
      provider: ctx.provider,
      model: ctx.model,
      body: transformed,
      apiKey: ctx.apiKey,
      keyMetadata: {},
      clientFmt: kind,
      providerFmt: kind,
      endpointKind: kind,
      forwardPath: endpointPathFor(ctx.provider, kind),
      baseUrl: ctx.baseUrl,
      basePath: ctx.basePath,
      resolve: ctx.resolve,
      url: ctx.resolve(kind),
      headers: xctx.headers!,
    });

    // Step 3: the one actual network call.
    const res = await ctx.request(built.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...built.headers },
      body: built.body,
      signal: ctx.signal,
    });
    let parsed: unknown;
    try {
      parsed = res.json();
    } catch {
      parsed = res.text;
    }

    // Step 4: the full stack's response side (same layers as step 1) —
    // success only.
    if (res.ok) {
      const respTransformed = applyBodyTransforms(
        plan.response,
        parsed as Json,
        xctx,
        ctx.logStage
          ? (name, changed) => ctx.logStage!("resp", name, changed)
          : undefined,
      );
      return {
        ok: true,
        status: res.status,
        data: opts?.summarize?.(respTransformed) ?? respTransformed,
        ms: res.ms,
      };
    }
    return { ok: false, status: res.status, data: parsed, ms: res.ms };
  }

  // --- provider-level connectivity test --------------------------------------
  // "Test connection" (provider Overview tab) and the per-key Test button
  // (Keys tab) both call this — a PROVIDER/key-pair reachability check, as
  // opposed to testModel()'s one-specific-upstream-model check. Same seam
  // philosophy as testModel()/keyUsage()/fetchModels(): ASYNC, and a real
  // implementation does the HTTP request itself.
  //
  // Unlike testModel() (whose generic default is an inert dummy stub — there's
  // no sane provider-agnostic guess at "can this reach a chat completion"),
  // EVERY provider in this catalog serves a model-list endpoint, so there IS a
  // universally sane default here: GET `ctx.url` (= the provider's
  // baseUrl+basePath+modelsPath) with the selected key's auth already applied,
  // and report reachable on any 2xx/3xx status. Override this only when
  // "reachable" means something other than "the model-list endpoint answers"
  // — a dedicated health endpoint, a signed probe, or (see example-custom.ts)
  // a provider with no real network dependency to check at all, where a
  // deterministic success is the correct and honest answer.
  //
  // `ctx.apiKey` is resolved by the CALLER before this runs — the live
  // rotation/health pick for the plain "Test connection" button, or an
  // operator-pinned specific key for the per-key Test button — this method
  // never chooses which key to test with, only whether/how to use the one
  // it's handed.
  async testProvider(ctx: TestProviderCtx): Promise<TestProviderResult> {
    const res = await ctx.request(ctx.url, {
      method: "GET",
      headers: ctx.headers,
      signal: ctx.signal,
    });
    return {
      // Deliberately wider than AdapterHttpResponse.ok (2xx only): a 3xx here
      // (e.g. a proxy issuing a redirect) still means "reachable and
      // responding", matching the historical connectivity-test behavior this
      // default replaces (see provider-probe.ts's now-legacy testProvider()).
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      ms: res.ms,
      sample: res.text ? res.text.slice(0, 240) : undefined,
    };
  }

  // Collected usage stages for one provider key, consumed by the admin route.
  // Kept alongside transforms()/buildFor() so all per-request behavior — how a
  // hop is built, how its body is transformed, AND how its usage is reported —
  // lives together on the adapter class.
}

// Deterministic pseudo-usage windows from a numeric seed, so the same key always
// renders the same bars across reloads (no Math.random flicker). Placeholder
// only — replaced when an adapter wires a real upstream usage query. Shows BOTH
// a token-limit window and a request-limit window so the UI exercises both units.
export function dummyUsageWindows(seed: number): ProviderKeyUsageWindow[] {
  // Small LCG so each window pulls a distinct-but-stable fraction from the seed.
  let s = seed >>> 0 || 1;
  const next = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const now = Date.now();
  const hour = 3600_000;
  const fiveHLimit = 2_000_000;
  const weekLimit = 40_000_000;
  const dailyReqLimit = 10_000;
  return [
    {
      id: "5h",
      label: "5-hour tokens",
      used: Math.floor(next() * fiveHLimit * 0.9),
      limit: fiveHLimit,
      unit: "tokens",
      resetsAt: new Date(now + Math.floor(next() * 5 * hour)).toISOString(),
    },
    {
      id: "weekly",
      label: "Weekly tokens",
      used: Math.floor(next() * weekLimit * 0.75),
      limit: weekLimit,
      unit: "tokens",
      resetsAt: new Date(
        now + Math.floor(next() * 7 * 24 * hour),
      ).toISOString(),
    },
    {
      id: "daily-requests",
      label: "Daily requests",
      used: Math.floor(next() * dailyReqLimit * 0.6),
      limit: dailyReqLimit,
      unit: "requests",
      resetsAt: new Date(now + Math.floor(next() * 24 * hour)).toISOString(),
    },
  ];
}

// A ProviderKeyUsage row (mask + enabled + windows) is assembled by the route
// from the adapter's keyUsage() output; re-exported shape for convenience.
export type { ProviderKeyUsage };

// GPT-5 family: models that reject legacy `max_tokens` (require
// `max_completion_tokens`) and don't support `temperature`. Matches GPT-5+,
// o3+, and Codex families so newly released models are covered without edits.
const GPT5_FAMILY = /^(gpt-([5-9]|\d{2,})|o[3-9]\d*|codex)/i;

export function isGPT5Family(model: string): boolean {
  return GPT5_FAMILY.test(model);
}

// True for model ids that are Responses-API-first. Forward-looking: matches
// families so newly released models are covered without edits.
export function prefersResponses(model: string): boolean {
  const m = model.toLowerCase();
  if (m.includes("codex")) return true;

  const gpt = m.match(/^gpt-(\d+)/);
  if (gpt && Number(gpt[1]) >= 5) return true;

  const gptImage = m.match(/^gpt-image-(\d+)/);
  if (gptImage && Number(gptImage[1]) >= 2) return true;

  const oSeries = m.match(/^o(\d+)/);
  if (oSeries && Number(oSeries[1]) >= 3) return true;

  return false;
}

// Native chat provider (OpenAI-compatible). All inbound formats route to the
// provider's chat endpoint by default (the engine bridges messages/responses ->
// chat) — but a per-link endpoint wins: pointing a hop at /v1/messages makes this
// provider take in AND emit the Messages format for that hop. The provider's
// native format ("chat") is only the fallback when no endpoint is chosen. Build
// methods inherit the verbatim default.
export class OpenAICompatibleAdapter extends ProviderAdapter {
  protected get nativeFmt(): WireFmt {
    return WireKind.Chat;
  }

  preferredEndpoint(model: string, accepted: WireKind[]): WireKind | undefined {
    if (accepted.includes(WireKind.Responses) && prefersResponses(model))
      return WireKind.Responses;

    return undefined;
  }

  chatCompletions(ctx: BuildCtx): BuiltRequest {
    if (isGPT5Family(ctx.model)) {
      const body = ctx.body as ChatCompletionRequest;
      delete body.temperature;
      delete body.top_p;
      delete body.top_k;
    }

    return super.chatCompletions(ctx);
  }

  responses(ctx: BuildCtx): BuiltRequest {
    if (isGPT5Family(ctx.model)) {
      const body = ctx.body as ResponsesRequest;
      delete body.temperature;
      delete body.top_p;
    }

    return super.responses(ctx);
  }

  async testModel(ctx: TestModelCtx): Promise<TestModelResult> {
    if (ctx.provider.endpoints?.includes(WireKind.Responses)) {
      return this.probeEndpoint(ctx, WireKind.Responses, {
        body: {
          model: ctx.model,
          input: "Reply with exactly: hi",
          max_output_tokens: 16,
        },
        summarize: (json) => {
          const r = json as ResponsesResponse;
          const msg = r.output?.find((o) => o.type === "message");
          const part = (
            msg?.content as Array<{ type?: string; text?: string }> | undefined
          )?.find((c) => c.type === "output_text");
          return { reply: part?.text ?? null };
        },
      });
    }

    const body: ChatCompletionRequest = {
      model: ctx.model,
      messages: [{ role: "user", content: "Reply with exactly: hi" }],
    };

    if (isGPT5Family(ctx.model)) {
      body.max_completion_tokens = 16;
    } else {
      body.max_tokens = 2;
      body.temperature = 0;
    }

    return this.probeEndpoint(ctx, WireKind.Chat, {
      body,
      summarize: (json) => {
        const reply = (json as ChatCompletionResponse).choices?.[0]?.message
          ?.content;
        return { reply: reply ?? null };
      },
    });
  }
}

function orderAnthropicKeys(
  body: AnthropicMessagesRequest,
): AnthropicMessagesRequest {
  // True final Messages boundary: every client/family/adapter/model transform has
  // already run, so no later stage can reintroduce a fifth cache breakpoint.
  limitAnthropicCacheControl(body);
  const ordered: Record<string, unknown> = {};
  for (const key of ORDERED_KEYS) {
    if (key in body) ordered[key] = body[key as keyof AnthropicMessagesRequest];
  }

  for (const key of Object.keys(body)) {
    if (!(key in ordered))
      ordered[key] = body[key as keyof AnthropicMessagesRequest];
  }

  return ordered as AnthropicMessagesRequest;
}

// Native messages provider (Anthropic-compatible). All inbound formats route to
// the provider's /messages endpoint by default (the engine bridges chat ->
// messages) — but a per-link endpoint wins: pointing a hop at /v1/chat/completions
// makes this provider take in AND emit the Chat format for that hop. The
// provider's native format ("messages") is only the fallback when no endpoint is
// chosen. Build methods inherit the verbatim default.
export class AnthropicCompatibleAdapter extends ProviderAdapter {
  protected get nativeFmt(): WireFmt {
    return WireKind.Messages;
  }

  messages(ctx: BuildCtx): BuiltRequest {
    return {
      url: ctx.url,
      headers: ctx.headers,
      body: orderAnthropicKeys(ctx.body as AnthropicMessagesRequest),
    };
  }

  async testModel(ctx: TestModelCtx): Promise<TestModelResult> {
    return this.probeEndpoint(ctx, WireKind.Messages, {
      summarize: (json) => {
        const r = json as AnthropicMessagesResponse;
        const text = r.content?.find((b) => b.type === "text");
        return { reply: (text as { text?: string })?.text ?? null };
      },
    });
  }
}
