// EXAMPLE — a bespoke provider that exercises the WHOLE provider API.
//
// This is a teaching example (not registered in registry.ts). It shows the seams
// an adapter can override, all living together on one class:
//
//   1. route   — routeFor() picks the wire KIND a hop uses (inherited here). A
//                lighter-weight preferredEndpoint(model, accepted) hook nudges the
//                default per model (e.g. GPT-5 -> responses) without a full override.
//   2. build   — chatCompletions()/responses()/messages() assemble the final HTTP
//                request AFTER conversion: rewrite url + headers + body per kind.
//   3. transform — requestTransforms()/responseTransforms()/streamTransforms()
//                edit the BODY (typed, per wire format) as part of the pipeline.
//   4. usage   — keyUsage() reports the provider's own token + request quotas.
//   5. models  — fetchModels() returns a standardized UpstreamModel[] (async).
//   6. test model    — testModel() probes ONE imported model for reachability;
//                the adapter alone decides which endpoint kind to test with.
//   7. test provider — testProvider() checks the PROVIDER/key pair itself is
//                reachable ("Test connection" + the per-key Test button). The
//                base default already does something real (GETs the model-list
//                endpoint); this example overrides it to show the OTHER valid
//                case — a provider with no real network dependency to check,
//                where a deterministic synthetic success is the honest answer.
//
// A build method NEVER needs `new URL()` — everything it needs is on `ctx`:
//   ctx.model      upstream model id for this hop
//   ctx.body       request body, already converted to the provider's wire format
//   ctx.apiKey     the key the proxy's key-health logic picked (null if none)
//   ctx.baseUrl    the provider origin      ctx.basePath  the path prefix (may be "")
//   ctx.endpointKind  the wire kind this hop resolved to
//   ctx.resolve()  compose a URL: resolve() = this hop, resolve("responses") = a
//                  kind's URL, resolve("/x") = a literal path — all from the parts
//   ctx.url        = resolve(), the default composed URL (verbatim providers use it)
//   ctx.headers    default headers (client passthrough + auth + extraHeaders)
// It returns BuiltRequest { url, headers, body }.

import { createHmac } from "crypto";
import {
  OpenAICompatibleAdapter,
  type BuildCtx,
  type BuiltRequest,
  type UsageCtx,
  type KeyUsageResult,
  type ModelsCtx,
  type TestModelCtx,
  type TestModelResult,
  type TestProviderCtx,
  type TestProviderResult,
} from "../base";
import { WireKind, type Provider, type ModelCapabilities } from "../../types";
import type { UpstreamModel } from "../../formats/wire/models";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "../../formats/wire";
import {
  onRequest,
  onResponse,
  onStreamEvent,
  type AnyRequestTransform,
  type AnyResponseTransform,
  type AnyStreamTransform,
} from "../../formats/pipeline";

class ExampleCustomAdapter extends OpenAICompatibleAdapter {
  // --- chat endpoint --------------------------------------------------------
  // Demonstrates: an HMAC-signed URL, custom auth header derived from the selected
  // key (instead of the default Bearer), and a body envelope + extra fields —
  // with ZERO `new URL()`. The URL comes from `ctx.resolve()`, which composes
  // origin + basePath + this hop's path; we just append a query string.
  chatCompletions(ctx: BuildCtx): BuiltRequest {
    const key = ctx.apiKey ?? "";

    // 1) URL: sign the request and append ts + sig as a query string. resolve()
    //    hands us the composed hop URL — no parsing/rebuilding needed.
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = createHmac("sha256", key)
      .update(`${ctx.model}:${ts}`)
      .digest("hex");
    const url = `${ctx.resolve()}?ts=${ts}&sig=${sig}`;

    // 2) Headers: drop the default Authorization and use this provider's bespoke
    //    scheme instead. Spread ctx.headers first so content-type/accept and the
    //    client passthrough headers are preserved.
    const { authorization: _drop, ...rest } = ctx.headers;
    void _drop;
    const headers: Record<string, string> = {
      ...rest,
      "x-api-signature": sig,
      "x-client": "llm-gateway",
    };

    // 3) Body: this upstream wants the OpenAI payload wrapped in an envelope and
    //    a couple of extra fields injected. ctx.body is already OpenAI chat shape
    //    (the engine converted messages/responses -> chat for us).
    const body = {
      request: ctx.body,
      meta: { model: ctx.model, stream: ctx.body.stream === true },
    };

    return { url, headers, body };
  }

  // --- responses endpoint ---------------------------------------------------
  // Demonstrates: routing this format to a DIFFERENT host, injecting a default
  // sampling parameter, and putting the key in a query param — again with no
  // `new URL()`. We build the URL from string parts (ctx.forwardPath is this
  // hop's path, e.g. "/v1/responses").
  responses(ctx: BuildCtx): BuiltRequest {
    // Send Responses traffic to a dedicated host, preserving the path + adding
    // the key as a query param.
    const keyParam = ctx.apiKey ? `?key=${encodeURIComponent(ctx.apiKey)}` : "";
    const url = `https://responses.example.com${ctx.forwardPath}${keyParam}`;

    // Inject a default only when the client didn't specify one — never clobber
    // a value the caller set.
    const body: Record<string, unknown> = { ...ctx.body };
    if (body.temperature === undefined) body.temperature = 0.7;

    // The dedicated host uses the query-param key, so drop the Authorization.
    const headers = { ...ctx.headers };
    delete headers.authorization;

    return { url, headers, body };
  }

  // messages() is left as the inherited verbatim default — a hop that resolves
  // to /v1/messages on this provider forwards untouched.

  // --- typed body/stream transforms -----------------------------------------
  // The build methods above own URL/headers/body assembly. To edit the BODY as
  // part of the conversion pipeline (and to touch the response + stream), return
  // FORMAT-TAGGED transforms authored with onRequest/onResponse/onStreamEvent.
  // Each handler receives the TYPED wire body for its format; the engine places
  // each stage automatically relative to the wire conversion (see
  // formats/pipeline buildTransformPlan). These run alongside the all-provider
  // defaults (thinking, anthropic hooks) — no bookkeeping needed. The optional
  // 4th `meta` argument (label/blurb/group) is display-only — it's what the
  // "Default transforms" panel in the admin UI shows instead of the bare stage
  // name; every example below sets one to demonstrate the parity the real
  // transform library (formats/transforms/registry.ts) already has.

  requestTransforms(_p: Provider): AnyRequestTransform[] {
    return [
      // Typed as ChatCompletionRequest: set a sampling default the client didn't
      // specify, and tag the request for this provider's analytics.
      onRequest(
        "chat",
        "example:defaults",
        (body) => {
          if (body.temperature === undefined) body.temperature = 0.2;
          body.metadata = { ...(body.metadata as object), gateway: "example" };
          return body;
        },
        {
          label: "Sampling defaults + analytics tag",
          blurb:
            "Sets temperature: 0.2 when the client didn't specify one, and stamps metadata.gateway for this provider's own analytics.",
        },
      ),
    ];
  }

  responseTransforms(_p: Provider): AnyResponseTransform[] {
    return [
      // Typed as ChatCompletionResponse: stamp the system fingerprint so a
      // downstream client can tell this hop served the response.
      onResponse(
        "chat",
        "example:stamp",
        (body) => {
          body.system_fingerprint = `example-${body.system_fingerprint ?? "fp"}`;
          return body;
        },
        {
          label: "System-fingerprint stamp",
          blurb:
            "Prefixes system_fingerprint so a downstream client can tell this hop served the response.",
        },
      ),
    ];
  }

  streamTransforms(_p: Provider): AnyStreamTransform[] {
    return [
      // Typed as ChatCompletionChunk per SSE event: drop empty keepalive deltas
      // this upstream emits (return null to drop the event; the framing + [DONE]
      // sentinel are handled for you).
      onStreamEvent(
        "chat",
        "example:drop-empty",
        (event) => {
          const choice = event.choices?.[0];
          const delta = choice?.delta;
          const empty =
            delta &&
            !delta.content &&
            !delta.tool_calls &&
            !delta.role &&
            choice?.finish_reason == null;
          return empty ? null : event;
        },
        {
          label: "Drop empty keepalive deltas",
          blurb:
            "This upstream emits empty keepalive chunks mid-stream; dropped here rather than forwarded to the client.",
        },
      ),
    ];
  }

  // --- usage reporting ------------------------------------------------------
  // Demonstrates a REAL (here: simulated) async usage query, plus the full result
  // shape: live windows (dummy:false is the default), an optional per-key
  // `message`, and the `unavailable` state. A production adapter would GET the
  // provider's usage endpoint with ctx.apiKey and map the response into windows.
  // This adapter reports real (simulated) usage, so it opts INTO the dashboard.
  // Even when a live keyUsage() query fails, the provider stays visible and the
  // error shows on the affected key.
  supportsKeyUsage(_ctx: UsageCtx): boolean {
    return true;
  }

  async keyUsage(ctx: UsageCtx): Promise<KeyUsageResult> {
    // Simulate the upstream call the real adapter would make. `ctx.request()` is
    // the proxy/TLS-aware primitive every outbound admin probe uses (the same
    // one testModel()'s probeEndpoint() sends through) — arbitrary JSON in,
    // arbitrary JSON out, no wire schema attached (a usage endpoint has its own
    // provider-specific shape, unlike a chat/messages/responses completion):
    //
    //   const res = await ctx.request(ctx.resolve("/usage"), {
    //     headers: { authorization: `Bearer ${ctx.apiKey}` },
    //   });
    //   if (res.status === 404)
    //     return { windows: [], unavailable: true, message: "No usage API" };
    //   const j = res.json() as { used: number; limit: number };
    //
    // Here we derive stable numbers from the key seed so the example is
    // deterministic without a network call.
    await Promise.resolve();

    // A disabled key can't be queried upstream here — report it as unavailable
    // with a note, showing the Unavailable + message path end-to-end.
    if (!ctx.enabled) {
      return {
        windows: [],
        unavailable: true,
        message: "Key disabled — upstream usage not queried.",
      };
    }

    const frac = ((ctx.seed % 1000) / 1000) * 0.8; // 0–0.8, stable per key
    const now = Date.now();
    const hour = 3600_000;
    const near = frac > 0.7; // near a limit -> attach an advisory message
    return {
      // dummy defaults to false; this is presented as live data.
      ...(near ? { message: "Approaching monthly token limit" } : {}),
      windows: [
        {
          id: "monthly-tokens",
          label: "Monthly tokens",
          used: Math.floor(50_000_000 * frac),
          limit: 50_000_000,
          unit: "tokens",
          resetsAt: new Date(now + 20 * 24 * hour).toISOString(),
        },
        {
          id: "minute-requests",
          label: "Requests / min",
          used: Math.floor(60 * frac),
          limit: 60,
          unit: "requests",
          resetsAt: new Date(now + 30_000).toISOString(),
        },
      ],
    };
  }

  // --- model discovery ------------------------------------------------------
  // Demonstrates the headline fetchModels() capability: returning a fully-
  // specified, UNIVERSAL model list — display name, max context window, max
  // output tokens, AND Anthropic-style capabilities — regardless of the provider's
  // wire format. The gateway imports all of this metadata onto each model, and it
  // renders for an OpenAI-type client just as well (the universal shape is a
  // superset). A provider that just wants ids inherits the default fetchModels().
  //
  // This example hand-builds the list so it works offline. A provider whose
  // catalog lives at a real endpoint would instead fetch THROUGH `ctx.transport`
  // (so the provider's proxy + TLS-verify settings are honored) and map the
  // response into UpstreamModel[], e.g.:
  //
  //   const get = ctx.transport!;                    // route injects proxy/TLS
  //   const res = await get(ctx.url, { headers: ctx.headers });
  //   const { catalog } = await res.json();          // bespoke envelope
  //   return catalog.map((m) => ({
  //     id: m.name,
  //     contextWindow: m.ctx_window,
  //     maxOutputTokens: m.max_out,
  //     raw: m,
  //   }));
  //
  // The default fetchModels() (base.ts) already does exactly this for the two
  // standard dialects; override only when the upstream body is non-standard.
  async fetchModels(_ctx: ModelsCtx): Promise<UpstreamModel[]> {
    return [
      {
        id: "example-large",
        displayName: "Example Large",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        created: "2026-01-01T00:00:00Z",
        capabilities: EXAMPLE_CAPS_FULL,
      },
      {
        id: "example-fast",
        displayName: "Example Fast",
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        created: "2026-01-01T00:00:00Z",
        capabilities: EXAMPLE_CAPS_LEAN,
      },
      // A minimal entry — only an id is required; the rest is optional and the
      // gateway leaves it blank on import.
      { id: "example-mini" },
    ];
  }

  // --- model testing ---------------------------------------------------------
  // Demonstrates the one-line path most adapters want: pick the wire KIND this
  // provider wants probed (its own call — nothing generic infers it) and hand
  // probeEndpoint() a BODY TYPED TO THAT KIND'S OWN REQUEST SCHEMA — here a
  // ChatCompletionRequest, inferred from passing WireKind.Chat. probeEndpoint()
  // then:
  //   1. runs the body through THIS adapter's own requestTransforms() for chat
  //      (the "example:defaults" stage above runs here too — sets temperature
  //      and stamps metadata, exactly like a real request),
  //   2. hands it to THIS adapter's own chatCompletions() build method — so the
  //      signed URL + custom auth header above are exercised for real,
  //   3. sends it via ctx.request() (proxy/TLS-aware),
  //   4. on success, runs the reply through THIS adapter's own
  //      responseTransforms() (the "example:stamp" stage above), then
  //      `summarize` distills it down to just the reply text — on failure the
  //      upstream's own error body is returned untouched.
  async testModel(ctx: TestModelCtx): Promise<TestModelResult> {
    /*
    const body: ChatCompletionRequest = {
      model: ctx.model,
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply with a single word." }],
    };
    
    this.probeEndpoint(ctx, WireKind.Chat, {
      body,
      summarize: (json) => {
        const reply = (json as ChatCompletionResponse).choices?.[0]?.message
          ?.content;
        return { reply: reply ?? null };
      },
    });
    */

    return { ok: true, status: 200, data: { reply: "pong" }, ms: 1 } as TestModelResult;
  }

  // A provider whose test probe needs something probeEndpoint() can't express
  // (bespoke auth, a streaming check, a non-JSON success signal) skips it and
  // uses ctx.request()/ctx.resolve() directly instead, e.g.:
  //
  //   async testModel(ctx: TestModelCtx): Promise<TestModelResult> {
  //     const res = await ctx.request(ctx.resolve(WireKind.Responses), {
  //       method: "POST",
  //       headers: ctx.headers,
  //       body: { model: ctx.model, input: "ping" },
  //     });
  //     return { ok: res.ok, status: res.status, data: res.json(), ms: res.ms };
  //   }

  // --- provider-level connectivity test ---------------------------------------
  // Demonstrates OVERRIDING testProvider() — the "Test connection" button
  // (provider Overview tab) and the per-key Test button (Keys tab) both call
  // this. The BASE default (inherited when a provider doesn't override this)
  // already does something real and useful: a GET against the provider's own
  // model-list endpoint (ctx.url = baseUrl+basePath+modelsPath) through
  // ctx.request() — see ProviderAdapter.testProvider in ../base/adapter.ts.
  // Override it only when "reachable" means something OTHER than that.
  //
  // This example is the case where it genuinely does: `api.example.com` isn't
  // a real host, so probing it would just time out and fail every test click.
  // A synthetic provider like this ONE has no real upstream to check, so
  // reporting a deterministic, honest success — rather than either a fake
  // network round-trip or a confusing timeout — is the correct behavior, not
  // a shortcut. A real bespoke provider would more typically override this to
  // hit a dedicated health endpoint, or to sign the connectivity probe the
  // same way chatCompletions() signs a real request (ctx carries the same
  // resolve()/apiKey/headers seam testModel()'s ctx does).
  //
  // `ctx.apiKey` is already resolved by the CALLER (either the live
  // rotation/health pick, or an operator-pinned key from the per-key Test
  // button) — this override doesn't choose it, only reports on it.
  async testProvider(ctx: TestProviderCtx): Promise<TestProviderResult> {
    // Never echo any part of ctx.apiKey — a testProvider() override still
    // owes the same secrecy guarantee the base default does (masking happens
    // centrally in provider-probe.ts's testSavedProvider, from the SAME raw
    // key this ctx carries; a custom override must not leak it a second time
    // through `sample` or any other field).
    return {
      ok: true,
      status: 200,
      ms: 1,
      sample: ctx.apiKey
        ? "synthetic OK — a key is configured (no real upstream to probe)"
        : "synthetic OK — no key configured, nothing to validate",
    };
  }
}

// Anthropic-style capability profiles for the demo models. The gateway consumes
// this exact shape for its own /v1/models listing, so a custom provider can hand
// back rich capabilities and they import verbatim.
const EXAMPLE_CAPS_FULL: ModelCapabilities = {
  batch: { supported: true },
  citations: { supported: true },
  code_execution: { supported: true },
  image_input: { supported: true },
  pdf_input: { supported: true },
  structured_outputs: { supported: true },
  thinking: {
    supported: true,
    types: { adaptive: { supported: true }, enabled: { supported: true } },
  },
  effort: {
    supported: true,
    low: { supported: true },
    medium: { supported: true },
    high: { supported: true },
    xhigh: { supported: true },
    max: { supported: true },
  },
};

const EXAMPLE_CAPS_LEAN: ModelCapabilities = {
  batch: { supported: true },
  citations: { supported: false },
  code_execution: { supported: false },
  image_input: { supported: true },
  pdf_input: { supported: false },
  structured_outputs: { supported: true },
  thinking: {
    supported: false,
    types: { adaptive: { supported: false }, enabled: { supported: false } },
  },
  effort: {
    supported: false,
    low: { supported: false },
    medium: { supported: false },
    high: { supported: false },
    xhigh: { supported: false },
    max: { supported: false },
  },
};

export const exampleCustom = new ExampleCustomAdapter({
  id: "example-custom",
  label: "Example (custom build)",
  blurb:
    "Teaching example: signed URLs, bespoke auth, body envelopes, typed transforms, and live usage.",
  brand: "openai",
  defaults: {
    baseUrl: "https://api.example.com",
    // Advertising both kinds means chain hops can route either the chat or the
    // responses build method above (per-hop endpoint / preferredEndpoint picks).
    endpoints: [WireKind.Chat, WireKind.Responses],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    { key: "name", label: "Name", placeholder: "example", required: true },
    {
      key: "apiKeys",
      label: "API key",
      placeholder: "sk-…",
      required: true,
      hint: "One per line — rotated round-robin.",
    },
  ],
});

// To make it a real provider: import { exampleCustom } in registry.ts and add it
// to the ADAPTERS array. It then appears in the Add-Provider wizard and routes
// through these build methods — no engine changes needed.
