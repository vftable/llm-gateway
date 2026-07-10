# Provider Adapter API

This document is the reference for `ProviderAdapter` — the class every stock
provider and every custom provider is built from. It covers the two-phase
route/build model, the five context shapes (`BuildCtx`/`UsageCtx`/
`TestModelCtx`/`TestProviderCtx`/`ModelsCtx`), the transform hooks, and how
to add a new provider. See [`docs/format-conversion.md`](./format-conversion.md)
for the wire-format conversion rules that run *around* an adapter, and
[`docs/transforms-api.md`](./transforms-api.md) for how to author a transform
stage and how a provider family's `quirks.defaultTransforms` composes into
the default provider transform stack.

---

## Where things live

```
src/providers/
  base/
    types.ts     — BuildCtx / UsageCtx / TestModelCtx / TestProviderCtx / ModelsCtx
                   + result shapes
    url.ts       — auth headers, URL/path composition, wire-kind resolution
    models.ts    — fetchModelList + OpenAI/Anthropic -> universal normalization
    adapter.ts   — the ProviderAdapter abstract class + the two compatible subclasses
    index.ts     — barrel (`export * from` all four)
  catalog/       — the 14 stock provider instances (one file each)
    anthropic-compatible.ts — also exports ANTHROPIC_DEFAULT_TRANSFORMS, the
                   shared family-default stack anthropic.ts and
                   anthropic-subscription.ts both inherit (see transforms-api.md)
  registry.ts    — ADAPTERS[] + lookup/dispatch functions
  quirks.ts      — applyTemplateDefaults / capabilitiesForTemplate (create/import time only)
  types.ts       — re-exports the catalog metadata shapes from ../types/catalog.ts
  index.ts       — the public barrel other modules import from
src/admin/routes/
  provider-probe.ts       — testProviderAdhoc (pre-create wizard) / testSavedProvider
                            (resolves the adapter, calls testProvider()) / testProviderModel
  resolved-transforms.ts  — resolveProviderTransforms() — see transforms-api.md
```

Everything outside `providers/` imports from `src/providers` (the barrel),
never from `base/` or `catalog/*` directly.

---

## The model: catalog metadata + routing behavior on one object

A `ProviderAdapter` instance is **both**:

1. **Catalog metadata** — the data the Add-Provider wizard renders (label,
   blurb, brand, default base URL/endpoints/auth, form fields, quirks).
   `adapter.toTemplate()` returns this as a plain `ProviderTemplate`.
2. **Routing + build behavior** — how a request for this provider is routed
   and shaped, as methods on the class.

This keeps "what a provider looks like in the UI" and "how a provider's
requests are actually built" in the same file, so adding a provider is
`catalog/<name>.ts` + one line in `registry.ts` — never a change split across
unrelated parts of the codebase.

Two base classes cover the two native wire dialects:

```ts
class OpenAICompatibleAdapter extends ProviderAdapter {
  protected get nativeFmt(): WireFmt { return WireKind.Chat; }
}
class AnthropicCompatibleAdapter extends ProviderAdapter {
  protected get nativeFmt(): WireFmt { return WireKind.Messages; }
}
```

A stock provider is almost always a plain `new OpenAICompatibleAdapter({...})`
or `new AnthropicCompatibleAdapter({...})` — no subclass needed unless it
overrides a build method, a transform hook, or `preferredEndpoint`. Subclass
only when the provider needs bespoke behavior (see `example-custom.ts` for a
subclass that exercises every seam, and `anthropic-subscription.ts` for a
minimal one that only adds request transforms).

---

## Phase 1 — route (`routeFor`)

Given the client's format, the provider row, an optional per-link endpoint
override, and the upstream model id, `routeFor` decides **which wire kind**
this hop uses:

```ts
routeFor(
  clientFmt: WireFmt,
  p: Provider,
  linkEndpoint: string | null,
  model = "",
): EndpointRoute  // { endpointKind, providerFmt, forwardPath }
```

Precedence (see `resolveKind` in `base/url.ts`):

1. A per-link endpoint pin (set on the model's chain-hop config) always wins.
2. Else the adapter's `preferredEndpoint(model, accepted)` — a lightweight,
   model-aware hook for e.g. "GPT-5-class models prefer `/v1/responses`"
   (see `catalog/openai.ts`'s `prefersResponses`).
3. Else `provider.endpoints[0]`.
4. Else the adapter's native kind (`nativeFmt`).

Override `routeFor` itself only to change **which kind** a hop routes
through under conditions `preferredEndpoint` can't express. To change the
request **shape** or **URL**, override a build method instead — `routeFor`
never touches the body.

---

## Phase 2 — build (`chatCompletions` / `messages` / `responses`)

After the engine converts the body to `ctx.providerFmt` and runs the ordered
transform stages, it calls the build method matching that format:

```ts
chatCompletions(ctx: BuildCtx): BuiltRequest
messages(ctx: BuildCtx): BuiltRequest
responses(ctx: BuildCtx): BuiltRequest
```

The **default** (`defaultBuild`) forwards the composed URL + headers + body
verbatim — this is correct for the overwhelming majority of OpenAI-compatible
and Anthropic-compatible providers, which is why most catalog entries
(`openai.ts`, `deepseek.ts`, `glm.ts`, `openrouter.ts`, …) declare **zero**
build-method overrides.

A build method receives everything it needs on `ctx` — **never** call
`new URL()`:

| Field | What it is |
|---|---|
| `ctx.model` | Upstream model id for this hop |
| `ctx.body` | Request body, already converted to the provider's wire format — mutable |
| `ctx.apiKey` | The key the proxy's key-health logic picked (`null` if none) |
| `ctx.baseUrl` / `ctx.basePath` | Provider origin / path prefix |
| `ctx.endpointKind` / `ctx.providerFmt` / `ctx.clientFmt` | The wire kinds in play for this hop |
| `ctx.resolve()` | Compose a URL: `resolve()` = this hop, `resolve("responses")` = a specific kind's path, `resolve("/x")` = a literal path — all origin+basePath aware |
| `ctx.url` | The default composed URL (`= resolve()`) — a verbatim provider just returns this |
| `ctx.headers` | Default headers: client passthrough + auth (from `apiKey` + `authScheme`) + `extraHeaders` |

Return `{ url, headers, body }` — any subset may be rewritten. Common
overrides:

- **Signed/HMAC URLs** — compute a signature from `ctx.apiKey` + `ctx.model`,
  append it as a query string on `ctx.resolve()`.
- **Custom auth header** — drop `headers.authorization` and add your own
  scheme, spreading `ctx.headers` first so passthrough/content-type survive.
- **Request envelopes** — wrap `ctx.body` in a provider-specific wrapper
  object, or inject extra top-level fields.
- **A dedicated host per endpoint kind** — build a different `url` inside
  `responses()` than `chatCompletions()` (see `example-custom.ts`).

`messages()` is left as the inherited verbatim default whenever a provider
has no bespoke Messages-shape behavior — a hop that resolves to `/v1/messages`
on that provider forwards untouched.

---

## Transform hooks (edit the BODY as part of the pipeline)

Build methods own URL/headers/final-body assembly *after* conversion. To
participate in the conversion pipeline itself — editing the body at a
specific point relative to the client↔provider format conversion, or
touching the streaming SSE — override the transform hooks instead:

```ts
requestTransforms(p: Provider): AnyRequestTransform[]   // default: []
responseTransforms(p: Provider): AnyResponseTransform[] // default: []
streamTransforms(p: Provider): AnyStreamTransform[]     // default: []
```

Author these with `onRequest` / `onResponse` / `onStreamEvent` from
`formats/pipeline` — format-tagged, typed to the wire shape they run against.
See **[Transforms API](./transforms-api.md)** for the full authoring guide;
the short version: a request transform tagged `"messages"` runs wherever the
body is in Messages shape on this hop (pre-conversion for a Messages client,
post-conversion for a hop converting *into* Messages), so the same transform
fires correctly regardless of which format the client used. Each factory
also takes an optional 4th `{ label, blurb, group }` argument (see
[transforms-api.md § Optional display
metadata](./transforms-api.md#optional-display-metadata-label--blurb--group))
so the stage shows a friendly name — instead of the bare `name` — in the
read-only resolved-transforms preview; see `catalog/example-custom.ts` for a
worked example on all three hook types.

These run **alongside** the all-provider defaults (Anthropic hooks, thinking
extraction) — no bookkeeping needed; `buildTransformPlan` merges and places
everything by tag.

---

## `BuildCtx` / `UsageCtx` / `TestModelCtx` / `TestProviderCtx` / `ModelsCtx`

Five context shapes, one per async seam an adapter can override (`BuildCtx`
is the exception — synchronous, see below). All five share the same design:
the caller (engine or admin route) composes the default URL/headers from
provider config and hands them in — an adapter **never** builds a URL by
hand.

### `BuildCtx` — phase 2 (see table above)

The only *synchronous* seam (build methods are not async — they only shape
a request; the engine sends it).

### `UsageCtx` — `keyUsage(ctx): Promise<KeyUsageResult>`

Reports upstream key-usage windows (token **and** request quotas, over any
time window) for the dashboard.

| Field | What it is |
|---|---|
| `ctx.apiKey` | Raw key for this row — query the provider's usage endpoint with it |
| `ctx.mask` | Masked form (head…tail) — safe for logs/labels; never surface the raw key |
| `ctx.enabled` | Whether this key is operator-enabled (still reported when disabled) |
| `ctx.seed` | Stable per-key seed for deterministic placeholder windows |
| `ctx.resolve` / `ctx.request` | URL composer + proxy/TLS-aware HTTP primitive (arbitrary JSON, no wire schema — a usage endpoint has its own shape) |

Two things gate visibility:

- `supportsKeyUsage(ctx): boolean` — **sync**, no network. Default `false`
  (hidden from the dashboard — most providers expose no usage endpoint, and a
  card full of empty keys is noise). Return `true` only when `keyUsage()` does
  a real query; a live-query failure then surfaces as "unavailable" on the
  affected **key**, not the whole provider disappearing.
- `keyUsage()` itself — default reports `{ windows: [], unavailable: true,
  message: "..." }`. An adapter with a real endpoint returns real windows; one
  that only wants demo bars can return `{ windows: dummyUsageWindows(ctx.seed),
  dummy: true }` (see `dummyUsageWindows` in `base/adapter.ts`).

### `ModelsCtx` — `fetchModels(ctx): Promise<UpstreamModel[]>`

Fetches the provider's model catalog. Same seam philosophy: **async**, does
the HTTP request itself. The endpoint is composed by the caller from
provider config (`ctx.url` = origin + basePath + modelsPath) — nothing here
hardcodes a `/v1/models` path.

The default implementation calls `fetchModelList` (auto-adds
`anthropic-version` for the Anthropic dialect) and normalizes the dialect-
specific shape into the universal `UpstreamModel[]` — one shape regardless of
which dialect the provider speaks (`id` + optional `displayName` /
`contextWindow` / `maxOutputTokens` / `capabilities`). Callers of
`fetchModels()` never branch on OpenAI-vs-Anthropic. Override only when the
upstream body is non-standard (bespoke envelope, extra auth, a hand-built
list — see `example-custom.ts`).

> **Dialect fallback for ad-hoc discovery.** `ModelsCtx.format` picks which
> dialect to fetch+parse in. For a **saved** provider this is always resolved
> from the adapter's `nativeFormat` (never guessed). For **ad-hoc** discovery
> during Add-Provider wizard probing (`POST /api/provider-catalog/test`, no
> saved provider yet), `fetchUpstreamModels` (`src/admin/routes.ts`) tries the
> Anthropic dialect first — it returns richer data (capabilities, context
> window, max output) than the OpenAI dialect's bare `{id, created}` — and
> falls back to OpenAI on a throw. This only applies when the caller didn't
> pin a format explicitly.

### `TestModelCtx` — `testModel(ctx): Promise<TestModelResult>`

Probes **one** imported model row (`ctx.model`) to confirm it's reachable —
the Imported Models table's per-row test action. Deliberately **not**
pre-resolved to a wire kind: only the adapter knows which kind
(chat/messages/responses) it wants to test with — there is no generic
"the provider's native endpoint."

The default is a dummy stub (`{ ok: true, data: { dummy: true, ... } }`, no
network call) so UI wiring works before any adapter implements a real probe.

**The one-line path almost every override wants:**

```ts
async testModel(ctx: TestModelCtx) {
  return this.probeEndpoint(ctx, WireKind.Chat);
}
```

`probeEndpoint(ctx, kind, opts?)` does all four steps for you:

1. Builds a minimal one-token request body typed to `kind`'s own schema
   (`minimalProbeBody`, or `opts.body` for a provider that needs a different
   shape) and runs it through the **FULL stack a live request to `kind` would
   apply** — the same layering, same order, as `engine.ts`'s `buildRoute`
   (see [the four transform layers](./transforms-api.md#the-four-transform-layers)):
   builtin all-provider defaults (Anthropic hooks, `<thinking>` extraction) →
   this provider's **family** defaults (`quirks.defaultTransforms`, minus
   anything `ctx.ownTransforms` overrides) → **this adapter's own**
   `requestTransforms()` → `ctx.ownTransforms` (the specific imported model's
   own config, when the caller has one — the route passes the `ProviderModel`
   row's `transforms`). A custom transform at ANY of these layers is
   exercised for real, not bypassed — and a provider with no family defaults
   and no adapter override (most of the OpenAI-family catalog: deepseek,
   gemini, glm, openrouter, the generic `openai-compatible` entry, …) still
   gets the builtin layer, so its probe isn't silently empty.
2. Hands the transformed body to **this adapter's own** build method for
   `kind` (`chatCompletions`/`messages`/`responses`) — bespoke auth,
   envelopes, and signed URLs run exactly as they would for a real request.
3. Sends the built request via `ctx.request()` (proxy/TLS-aware, same
   transport `fetchModels()` uses).
4. On success, runs the reply through the same full stack's response side,
   then `opts.summarize?.(json)` distills it (default: the raw parsed JSON).
   On failure, the upstream's own error body is returned untouched —
   transforms don't run on an error, same as a real request.

A provider whose test truly can't be expressed as a typed completion body
(bespoke auth beyond what a build method can express, a streaming check, a
non-JSON success signal) skips `probeEndpoint()` and uses `ctx.request()` /
`ctx.resolve()` directly.

**Debug tracing.** `probeEndpoint()` prints the same per-stage `XFORM`
console trace a live request gets — the declared plan (every layer above, in
order) and each stage's actual application (with a `changed` flag) — whenever
`ctx.logStage` is set. The route (`admin/routes/provider-probe.ts`'s
`testProviderModel`) sets it automatically when `settings.debugLogging` is on
(Settings → General → "Debug request logging"); it's `undefined` otherwise,
so there's zero cost in normal operation. A bespoke `testModel()` override
that skips `probeEndpoint()` and calls `applyBodyTransforms()`/`ctx.request()`
directly can call `ctx.logStage` itself for parity.

### `TestProviderCtx` — `testProvider(ctx): Promise<TestProviderResult>`

The **provider**-level connectivity check — "Test connection" (provider
Overview tab) and the per-key Test button (Keys tab). Different scope from
`testModel()`: this checks the provider/key pair is reachable **at all**,
not any one specific upstream model — there's no `ctx.model` here.

Unlike `testModel()` (whose generic default is an inert dummy stub — there's
no sane provider-agnostic guess at "can this reach a chat completion"),
**every provider in this catalog serves a model-list endpoint**, so
`testProvider()` DOES have a universally sane default:

```ts
// base/adapter.ts — this is what every adapter gets for free
async testProvider(ctx: TestProviderCtx): Promise<TestProviderResult> {
  const res = await ctx.request(ctx.url, { method: "GET", headers: ctx.headers });
  return {
    ok: res.status >= 200 && res.status < 400,  // 3xx counts as reachable
    status: res.status,
    ms: res.ms,
    sample: res.text ? res.text.slice(0, 240) : undefined,
  };
}
```

`ctx.url` defaults to the provider's model-list endpoint
(`baseUrl+basePath+modelsPath`, same target `fetchModels()`'s default probes)
— `ctx.resolve()` with no argument returns this; `ctx.resolve(WireKind.Chat)`
(etc.) resolves a specific wire kind's path instead, same disambiguation as
`TestModelCtx.resolve`.

**Override this only when "reachable" means something other than "the
model-list endpoint answers"** — a dedicated health endpoint, a signed
probe (reuse the same signing logic a build method would apply), or (see
`example-custom.ts`) a provider with **no real network dependency to check
at all**, where a deterministic synthetic success is the correct and honest
answer rather than either a fake round-trip or a confusing timeout:

```ts
// example-custom.ts — a provider with nothing real to probe
async testProvider(ctx: TestProviderCtx): Promise<TestProviderResult> {
  return {
    ok: true,
    status: 200,
    ms: 1,
    sample: ctx.apiKey
      ? "synthetic OK — a key is configured (no real upstream to probe)"
      : "synthetic OK — no key configured, nothing to validate",
  };
}
```

`ctx.apiKey` is resolved by the **caller** before this runs — either the
live rotation/health pick (the plain "Test connection" button) or an
operator-pinned specific key (the per-key Test button in the Keys tab) —
this method never chooses which key to test with, only whether/how to use
the one it's handed. **Never echo any part of `ctx.apiKey`** in the result
(e.g. via `sample`) — masking (`keyMask`) happens exactly once, centrally,
in `provider-probe.ts`'s `testSavedProvider`, from the same raw key; a
`testProvider()` override leaking it a second time defeats that guarantee.

| Field | What it is |
|---|---|
| `ctx.url` / `ctx.resolve` | Default target = the model-list endpoint; `resolve(kind)` for a specific wire kind's path instead |
| `ctx.apiKey` | The raw key this attempt sends — resolved by the caller, not this method |
| `ctx.headers` | Default headers (auth for `ctx.apiKey` + `extraHeaders`) already applied |
| `ctx.request` | Proxy/TLS-aware transport — same shape as `TestModelCtx.request` |

`TestProviderResult` mirrors `TestModelResult`'s philosophy (surface the
REAL outcome) with two provider-level additions: `sample` (a short response
snippet — diagnostic context on failure) and `keyMask` (filled in by the
**caller**, not the adapter, right before the result reaches the response).

---

## Custom providers: the full seam list

Everything a bespoke adapter can override, all demonstrated together in
[`catalog/example-custom.ts`](../src/providers/catalog/example-custom.ts) (a
teaching example, not registered in `registry.ts`):

| Seam | Method | Sync/async | Purpose |
|---|---|---|---|
| route | `routeFor` (or the lighter `preferredEndpoint`) | sync | Which wire kind a hop uses |
| build | `chatCompletions` / `messages` / `responses` | sync | Final `{url, headers, body}` per format |
| transform | `requestTransforms` / `responseTransforms` / `streamTransforms` | sync (returns declarative stages) | Edit the body as a pipeline stage |
| usage | `supportsKeyUsage` (sync) + `keyUsage` (async) | mixed | Dashboard quota windows |
| models | `fetchModels` | async | Provider's model catalog |
| test model | `testModel` (or `probeEndpoint` inside it) | async | Per-model reachability probe |
| test provider | `testProvider` | async | Provider/key-pair connectivity check ("Test connection" + per-key Test) |

A minimal real provider only ever touches **route** (via `preferredEndpoint`)
and/or **build**. Usage/models/test-model/test-provider overrides are opt-in
polish, not required for a provider to work — `testProvider()` is the one
exception with a REAL (not dummy) default, since a model-list GET is a
universally sane connectivity check for anything in this catalog.

---

## Adding a new stock provider

1. Create `src/providers/catalog/<name>.ts` exporting an instance:

   ```ts
   import { OpenAICompatibleAdapter } from "../base";
   import { WireKind } from "../../types";

   export const myProvider = new OpenAICompatibleAdapter({
     id: "my-provider",
     label: "My Provider",
     blurb: "One-line description shown in the catalog grid.",
     brand: "openai", // resolves a brand icon in the web UI; falls back to a chip
     defaults: {
       baseUrl: "https://api.my-provider.com",
       endpoints: [WireKind.Chat],
       authScheme: "bearer",
       nativeConversion: false,
     },
     fields: [
       { key: "name", label: "Name", placeholder: "my-provider", required: true },
       { key: "apiKeys", label: "API key", placeholder: "sk-…", required: true,
         hint: "One per line — rotated round-robin." },
     ],
   });
   ```

   Subclass `OpenAICompatibleAdapter`/`AnthropicCompatibleAdapter` instead of
   instantiating directly when the provider needs a build-method override, a
   transform hook, or `preferredEndpoint` — see `anthropic-subscription.ts`
   for a minimal subclass and `example-custom.ts` for the full seam list.

2. Add the instance to `ADAPTERS` in `src/providers/registry.ts`. Order there
   is the catalog grid's display order — branded stock providers first,
   generic escape-hatch templates (`openai-compatible`/`anthropic-compatible`/
   `proxy`) last.

That's it — the provider appears in the Add-Provider wizard immediately (via
`toTemplate()`) and routes through its adapter. No engine changes needed; the
engine only ever calls through the `ProviderAdapter` interface
(`adapterForProvider`, `routeFor`, `buildFor`, `transforms`, `keyUsage`,
`fetchModels`, `testModel`, `testProvider`).

### `ProviderTemplate` field reference

| Field | Purpose |
|---|---|
| `id` | Stable catalog id — stored on a `Provider` row as `catalogId`, used to resolve the adapter on every request |
| `label` / `blurb` / `brand` | Wizard display |
| `defaults` | `ProviderDefaults` — pre-fills the wizard form (baseUrl, endpoints, authScheme, extraHeaders, retry/timeout knobs, …) |
| `fields` | Which form fields the wizard renders (`name`/`apiKeys`/`baseUrl`), with labels/placeholders/hints |
| `quirks?` | `ProviderQuirks` — see below |
| `docsUrl?` | Link shown in the wizard |

`ProviderQuirks` are declarative. Three of the four fields apply **only** at
provider-create and model-import time (never on the request hot path, so
they can't regress streaming or conversion — see `src/providers/quirks.ts`);
`defaultTransforms` is the exception — see its own row:

| Field | Effect |
|---|---|
| `requiredHeaders` | Merged into the provider's `extraHeaders` on create (e.g. `anthropic-version`) |
| `thinking` | Seeds a newly-imported model's thinking capability (`defaultType`, `supportsEffort`) |
| `defaultCapabilities` | Merged onto `DEFAULT_CAPABILITIES` for imported models |
| `defaultTransforms` | Family-default per-model transforms (see [transforms-api.md § The default provider transform stack](./transforms-api.md#the-default-provider-transform-stack)). **Not** seeded into a model's stored config at import — applied fresh as an always-on base layer on **every request** (`familyDefaultTransforms` / `dropOverriddenDefaults`, called from `engine.ts`'s `buildChain`), so a change here reaches every existing provider/model immediately, no re-import needed. Runs **before** the adapter's own `requestTransforms()`/etc. stack (see below), so e.g. prompt-caching breakpoints are in place before an adapter-specific stage inspects the body. `ANTHROPIC_DEFAULT_TRANSFORMS` (`catalog/anthropic-compatible.ts`) is the one declared today, shared by `anthropic`/`anthropic-compatible`/`anthropic-subscription` via a single array reference. |

---

## Where the adapter meets the engine

`src/gateway/engine.ts`'s `buildChain` + `buildRoute` are the two places that
compose everything an adapter (and its family) declares into a per-attempt
plan:

1. **`buildChain`** — for each hop, computes the provider family's
   `defaultTransforms` (`familyDefaultTransforms(provider)`) minus anything
   the imported model's own config overrides by `id+phase`
   (`dropOverriddenDefaults`), and keeps that `familyTransforms` list
   **separate** from the model's `ownTransforms` on the `ChainEntry` — so
   `buildRoute` can place them on opposite sides of the adapter's own stack.
2. **`buildRoute`** — resolves the adapter (`adapterForProvider`) and calls
   `routeFor` (or, for a `nativeConversion` provider, uses the client's own
   format+path unchanged); collects the all-provider defaults
   (`collectDefaults` — Anthropic hooks + thinking), then `familyTransforms`
   resolved into stages (`modelTransformBags`), then the adapter's own
   `transforms(provider)`, then `ownTransforms` resolved into stages — in
   that order: **builtin → family → adapter → model**, so an operator's
   per-model customization always has the final say.
3. Hands everything to `buildTransformPlan` (`formats/pipeline.ts`), which
   places each stage relative to the client↔provider format conversion.

Then, per attempt (`attemptOnce`): run the request through `route.request`
(`applyBodyTransforms`), stamp the upstream model, compose the default
URL/headers, and call `route.adapter.buildFor(route.providerFmt, ctx)` — the
adapter's build method runs **last**, so it wins over anything a request
transform rewrote via `ctx.headerOverrides`/`ctx.urlOverride`.

This two-phase split — transforms edit the body as a declared pipeline stage,
the build method assembles the final request afterward — is what lets a
transform be *provider-agnostic* (it only ever sees a typed wire body) while
a build method stays *fully bespoke* (it sees the real key, the real URL
parts, and returns whatever the upstream actually needs).

Both `buildChain` and `buildRoute` run **fresh on every request** — nothing
from either step is cached, so `GET /providers/:id/transforms/resolved`
(`resolveProviderTransforms`, see
[transforms-api.md](./transforms-api.md#inspecting-the-resolved-stack--get-providersidtransformsresolved))
can reproduce the same composition outside a live request, purely for
inspection — it's the same logic, not a separate approximation of it.
