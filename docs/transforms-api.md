# Transforms API

This document is the reference for how the gateway edits request/response
bodies as part of the forwarding pipeline: the tagged authoring API
(`onRequest`/`onResponse`/`onStreamEvent`), how a tagged stage gets *placed*
relative to wire-format conversion, the all-provider defaults registry, the
**default provider transform stack** (family-wide defaults like Anthropic
prompt caching, and how to inspect exactly what a provider does via
`GET /providers/:id/transforms/resolved`), and the user-configurable
transform library. See [`docs/provider-adapters.md`](./provider-adapters.md)
for how a provider adapter contributes its own transforms (and its
`testProvider()` connectivity-check seam), and
[`docs/format-conversion.md`](./format-conversion.md) for the wire-format
conversion rules these transforms run alongside.

**Quick links:** [the four transform layers](#the-four-transform-layers) ·
[the default provider transform stack](#the-default-provider-transform-stack) ·
[inspecting the resolved stack](#inspecting-the-resolved-stack--get-providersidtransformsresolved) ·
[adding a new transform](#adding-a-new-transform) ·
[file checklist](#file-checklist-adding-a-new-default-transformation)

---

## The four transform layers

Every request passes through transforms from **four** sources — together,
"the default provider transform stack" plus whatever the model adds on top:

1. **Builtin defaults** (`formats/transforms/defaults.ts`) — always on,
   regardless of provider. Anthropic request hooks + `<thinking>` extraction
   today. Hand-authored pipeline code, not backed by the transform library.
2. **Family defaults** — `quirks.defaultTransforms` declared on a provider's
   catalog adapter (e.g. `ANTHROPIC_DEFAULT_TRANSFORMS` — prompt caching +
   tool-arg sanitize for every Anthropic-native provider). Backed by the
   transform **library** (`TRANSFORM_LIBRARY`), so these are full,
   parameterized, named transforms — just declared once per family instead
   of picked per model. Runs **before** the adapter's own stack (layer 3) so
   e.g. prompt-caching breakpoints are already in place before an
   adapter-specific stage inspects/rewrites the body. See **[The default
   provider transform stack](#the-default-provider-transform-stack)** below.
3. **Adapter transforms** — a provider's own
   `requestTransforms()`/`responseTransforms()`/`streamTransforms()`
   overrides (see [provider-adapters.md](./provider-adapters.md)). Also
   hand-authored code (e.g. `anthropic-subscription`'s no-op stack).
4. **Model transforms** — per-imported-model, UI-configured library
   transforms (`formats/transforms/registry.ts`'s `TRANSFORM_LIBRARY`,
   picked and parameterized per model, no code needed). A model entry with
   the same `(id, phase)` as a family default **overrides** it (dropped from
   layer 2 — see `dropOverriddenDefaults` below) and always runs **last**,
   so an operator's explicit per-model customization has the final say over
   both the family default and the adapter's own stack.

Layer 1 is collected into `defaults`; layer 3 into the adapter's
`AdapterTransforms` bag; layers 2 and 4 are each a `ModelTransformConfig[]`
(family's own list has already had any model-overridden entries dropped via
`dropOverriddenDefaults` — see `buildChain`) resolved into stages by
`modelTransformBags`. All four are combined in this order, every request, by
`engine.ts`'s `buildRoute`:

```
familyTransforms = dropOverriddenDefaults(familyDefaultTransforms(provider), imported?.transforms ?? [])
ownTransforms    = imported?.transforms ?? []
extra.request  = [...defaults.request,  ...modelTransformBags(familyTransforms).request,  ...adapterBag.request,  ...modelTransformBags(ownTransforms).request]
extra.response = [...defaults.response, ...modelTransformBags(familyTransforms).response, ...adapterBag.response, ...modelTransformBags(ownTransforms).response]
extra.stream   = [...defaults.stream,   ...adapterBag.stream]
```

Recomputed **fresh on every request** — nothing here is cached or baked into
a stored row, so a code-level change to any of the four layers (a new
builtin default, a new family default, an adapter update) takes effect
immediately for every provider/model, with zero re-import or migration step.
Use **`GET /providers/:id/transforms/resolved`** (below) to see exactly what
this composition produces for a given provider — the same view the admin UI
renders read-only, so "what does this provider actually do" is never a
guess.

---

## Where things live

```
src/formats/
  pipeline.ts            — TransformCtx, tagged-transform types, onRequest/onResponse/
                            onStreamEvent factories, buildTransformPlan, applyBodyTransforms
  transforms/
    defaults.ts           — DEFAULT_TRANSFORMS registry (builtin, layer 1)
    registry.ts            — TRANSFORM_LIBRARY (the library layers 2+4 draw from)
    apply.ts                — buildModelTransforms / modelTransformBags / mergeTransforms /
                               dropOverriddenDefaults
    builtins-extra.ts        — the more-than-trivial library transform bodies
                               (anthropicCache, systemPrepend, sanitizeToolArgs)
    index.ts                 — barrel (registry + apply exports)
  anthropic/hooks/
    stack.ts                — defaultAnthropicRequestHooks() — the messages-tagged stack
    thinking-signature.ts    — thinkingBlocksToText / stripThinkingBlocks
    thinking-config.ts       — adaptive→enabled, budget_tokens floor/ceiling, system hoist
    max-tokens.ts             — clamp to the hop ceiling
  anthropic/prefill.ts      — trailing-user-turn fix
  thinking/transforms.ts    — defaultThinkingResponse / defaultThinkingStream
src/providers/
  catalog/anthropic-compatible.ts — ANTHROPIC_DEFAULT_TRANSFORMS (family layer, Anthropic family)
  registry.ts                     — familyDefaultTransforms / defaultTransformsForCatalog
src/admin/routes/
  resolved-transforms.ts    — resolveProviderTransforms() — composes all 4 layers into
                              the read-only preview GET /providers/:id/transforms/resolved
                              serves; the module's own header comment is the canonical
                              description of the composition order
web/src/
  components/default-transforms.tsx  — <DefaultTransformsPanel> — read-only, collapsible,
                                        grouped UI for the resolved stack (Models tab,
                                        imported-model rows)
  components/ui/collapsible.tsx      — thin shadcn/Radix wrapper (Collapsible/
                                        CollapsibleTrigger/CollapsibleContent) — the
                                        primitive DefaultTransformsPanel builds on
  components/transform-editor.tsx    — <TransformEditor> — EDITABLE UI for a model's
                                        own (layer-4) transforms only
```

---

## Authoring a transform: `onRequest` / `onResponse` / `onStreamEvent`

A **tagged** transform declares two things up front:

- **phase** — `"request"` (client→upstream) or `"response"`
  (upstream→client, buffered or streaming)
- **format** — which wire format (`chat` | `messages` | `responses`) the
  handler is *written for* — i.e. the shape the body will actually be in
  when this stage runs

```ts
import { onRequest, onResponse, onStreamEvent } from "../../formats/pipeline";

// Request: typed to ChatCompletionRequest. Mutate + return, or return a new object.
onRequest("chat", "my:set-default-temp", (body, ctx) => {
  if (body.temperature === undefined) body.temperature = 0.2;
  return body;
});

// Buffered response: typed to the response shape for `format`.
onResponse("chat", "my:stamp-fingerprint", (body, ctx) => {
  body.system_fingerprint = `mine-${body.system_fingerprint ?? "fp"}`;
  return body;
});

// Streaming: called once per parsed SSE event. Return the edited event, or
// null to DROP it. SSE framing/parsing/[DONE] is handled for you.
onStreamEvent("chat", "my:drop-empty-deltas", (event, ctx) => {
  const empty = !event.choices?.[0]?.delta?.content;
  return empty ? null : event;
});
```

Each factory infers the body/event type from the `format` literal via
`WireRequest<F>`/`WireResponse<F>`/`WireStreamEvent<F>` (see
`formats/wire/index.ts`), so a handler edits the *actual* typed shape — a
`"messages"`-tagged `onRequest` handler sees `AnthropicMessagesRequest`, not
a generic `Record<string, unknown>`. The runtime `apply`/`create` are
type-erased to `Json`/`Transform` internally so the engine can treat every
stage uniformly; the factory does the (safe) cast.

Every stage needs a **unique, namespaced name** (`"provider:short-id"` or
`"model:transform-id"` convention) — it shows up in the debug per-stage
trace log (`ctx.debug` → `logger.transform`) and is used to dedupe
overrides in `mergeTransforms`.

`TransformCtx` (handed to every `apply`/`create`/`handle`) carries:

| Field | Use |
|---|---|
| `provider` | The `Provider` row for this hop |
| `clientFmt` / `providerFmt` | The wire formats in play |
| `alias` | The exposed model alias this request resolved to |
| `upstreamModel` | The chain hop's upstream model id |
| `maxOutputTokens` | Effective per-hop output ceiling (link ?? imported ?? model) |
| `headerOverrides` | A **request** transform may set this (string = set/replace, `null` = delete) to rewrite outbound headers — read back by the engine after request stages run, merged into the default header set *before* the adapter's build phase |
| `urlOverride` | A **request** transform may set this to replace the composed upstream URL — same timing as `headerOverrides` |

Both side-channel fields are reset fresh per attempt, so a rewrite can't leak
across retries or hops. A build method still runs **after** — and wins over
— anything a request transform set here (see
[provider-adapters.md](./provider-adapters.md#where-the-adapter-meets-the-engine)).

### Optional display metadata: `label` / `blurb` / `group`

`onRequest`/`onResponse`/`onStreamEvent` all accept an optional 4th argument
— a `TransformMeta` object — purely for how the stage shows up in the
read-only [resolved-transforms preview](#the-default-provider-transform-stack):

```ts
onRequest(
  "messages",
  "anthropic:thinking-signature",
  (body, ctx) => /* ... */,
  {
    label: "Thinking-signature normalization",
    blurb: "Rewrites every thinking block to signature-free text...",
    group: "anthropic-hooks",
  },
);
```

| Field | Effect |
|---|---|
| `label` | Short human name shown instead of the raw stage `name` (e.g. `"anthropic:thinking-signature"` → `"Thinking-signature normalization"`). Omit it and the UI humanizes the `name` suffix after the last `:` instead — never a requirement to set. |
| `blurb` | One-line description shown under the label. |
| `group` | Clusters this stage with every SIBLING (same phase, same source) that sets the identical `group` string under one collapsible row in the UI, instead of one row each — see the four Anthropic request hooks in `anthropic/hooks/stack.ts` (all `group: "anthropic-hooks"`) for the pattern. |

None of these three fields are read by the engine or the pipeline itself —
`buildTransformPlan`/`applyBodyTransforms` never look at them. They exist
purely so a hand-authored builtin/adapter stage can carry the same kind of
friendly label+blurb a library `TransformDef` already has (see [The
user-configurable transform
library](#the-user-configurable-transform-library-formatstransformsregistryts)
below) — for parity, not because the pipeline needs it. The untagged legacy
shapes (`RequestTransform`/`ResponseTransform`/`StreamTransform`, used by
`formats/anthropic/subscription/index.ts`'s no-op stack) accept the same
three fields as plain object properties (no factory to route them through —
see that file for the pattern).

**Naming convention** — this is declarative, not enforced by the type
system, but every stage in the codebase follows it: the raw `name` is
`"namespace:short-id"` (e.g. `"anthropic:max-tokens"`,
`"model:anthropic-cache"`, `"web-tools:rewrite:chat"`) — `namespace` is the
owning subsystem/adapter, `short-id` is what the stage does. `label`/`blurb`
are a SEPARATE, purely human-facing name — set them to whatever reads well
in a sentence; there's no naming scheme to match. Don't invent a new `name`
scheme for a stage you're adding — reuse the namespace it already belongs to
(`anthropic:`, `model:`, your provider's catalog id, etc.) and add `label`
for the friendly version instead of trying to make `name` itself read well.

---

## Placement: how a tagged stage lands in the right pipeline slot

This is the core mechanism that makes format-tagged transforms provider- and
direction-agnostic. `buildTransformPlan` (`formats/pipeline.ts`) receives
`clientFmt`, `providerFmt`, and the merged `extra` bag, and places each
stage by comparing its `format` tag against the two formats in play:

```
request  (client → provider):
  [ ...tagged==clientFmt,   format-convert(client→provider), ...tagged==providerFmt, ...untagged ]

response (provider → client), buffered or streaming:
  [ ...tagged==providerFmt, format-convert(provider→client), ...tagged==clientFmt,   ...untagged ]
```

So a stage always sees the body in the shape it was **written for**:

- A request stage tagged the **client** format runs *before* conversion
  (edits the body as the client sent it).
- A request stage tagged the **provider** format runs *after* conversion
  (edits the body as it's about to be sent upstream) — this is what the
  Anthropic request hooks use: tagged `"messages"`, so they engage
  post-conversion for a Chat client hitting a Messages provider, and
  pre-conversion (i.e. natively, no bridge involved) for a Messages client
  hitting a Messages provider.
- A response/stream stage tagged the **provider** format runs *before* the
  provider→client bridge (reads provider-native field names) — this is what
  thinking extraction uses, so `<thinking>`/`reasoning_content` extraction
  happens on the raw upstream shape before any renaming.
- A response/stream stage tagged the **client** format runs *after* the
  bridge (edits the body as the client is about to receive it).
- A stage tagged a format that's **neither** `clientFmt` nor `providerFmt` on
  this hop is **skipped entirely** — its shape never occurs on this hop, so
  there's nothing for it to act on. (E.g. a `"messages"`-tagged stage
  contributes nothing to a pure `chat↔responses` hop.)
- **Untagged** (legacy `RequestTransform`/`ResponseTransform`/
  `StreamTransform`, no `format` field) stages always land **last**, post-
  conversion — this is the historical placement, kept for per-model library
  transforms (`formats/transforms/apply.ts`'s `buildModelTransforms`), which
  are written against whatever shape the *model's provider* actually speaks,
  not a specific client format.

Ordering **within** a bucket (same phase, same format) follows the merge
order from the four layers above — builtin defaults, then family defaults,
then adapter, then model — so, e.g., the Anthropic `thinking-signature` hook
(a builtin default) always runs before any adapter-specific Messages-shape
request transform, and a family default like `anthropic-cache` always runs
before an adapter's own stack (e.g. `anthropic-subscription`'s hooks).

A tagged stage never needs to know or care whether conversion is even
happening on this hop — the engine's placement logic handles both the
"client and provider share a format" case (no bridge; pre/post collapse to
the same slot) and the "client and provider differ" case identically.

---

## `buildTransformPlan` / `applyBodyTransforms`

Two functions do the actual work, both exported from `formats/pipeline.ts`:

```ts
function buildTransformPlan(
  clientFmt: WireFmt,
  plan: { forwardPath: string; providerFmt: WireFmt; unsupported?: string },
  extra?: AdapterTransforms,
  onStage?: StageObserver,
): TransformPlan
```

Composes the ordered `request`/`response`/`stream` stage arrays for one
attempt: built-in format conversion (from `REQUEST_CONVERTERS`/
`RESPONSE_CONVERTERS`/`STREAM_BRIDGES` — see
[format-conversion.md](./format-conversion.md)) interleaved with the tagged
`extra` stages per the placement rule above. Returns `unsupported: string`
instead of a plan when the client/provider format pair has no converter at
all — the engine treats this as a signal to skip to the next chain hop.

```ts
function applyBodyTransforms(
  transforms: Array<RequestTransform | ResponseTransform>,
  body: Json,
  ctx: TransformCtx,
  onApply?: (name: string, changed: boolean) => void,
): Json
```

Runs an ordered stage list, threading `ctx` through each. A throwing stage
propagates to the caller — every call site in `engine.ts` wraps this in a
guard so one bad transform fails over the current attempt/hop instead of
crashing the request (see format-conversion.md's **Failover invariant**).
`onApply` (debug-only) fires per stage with whether the body actually
changed, for the per-transformation trace log.

Streaming stages are materialized differently: `route.stream` is an array of
`StreamTransform`/`TaggedStreamTransform`, each `.create(ctx)` returning a
Node `Transform` — the engine pipes them as sequential stages
(`streamPipeline([upRes, ...stages, clientSink])`) rather than composing one
function, so a two-hop bridge (e.g. `responses↔messages`, which chains
through Chat) is just two stages, not bespoke glue.

---

## The all-provider defaults registry (`formats/transforms/defaults.ts`)

A `DefaultTransformSet` is one always-on behavior, declared once and applied
to every route regardless of provider:

```ts
interface DefaultTransformSet {
  id: string;
  request?(ctx: DefaultCtx): AnyRequestTransform[];
  response?(ctx: DefaultCtx): AnyResponseTransform[];
  stream?(ctx: DefaultCtx): AnyStreamTransform[];
}
```

`DefaultCtx` is intentionally minimal — just what defaults collectively
need (`thinking: ThinkingConverter`, `providerFmt: WireFmt`) — grown only
when a genuinely new default needs more route context.

Currently registered:

| id | Stages | Why it's a default, not per-adapter |
|---|---|---|
| `anthropic-hooks` | `defaultAnthropicRequestHooks()` — tagged `"messages"` | Applies to *any* hop that emits Messages shape, whether the provider is native Anthropic or a Claude model routed through an OpenAI-catalog provider's `/v1/messages` link — not a property of one adapter |
| `thinking` | `defaultThinkingResponse`/`defaultThinkingStream`, filtered to the hop's `providerFmt` | `<thinking>`/`reasoning_content` extraction must run on every provider's raw output, and only once (pre-bridge, on the provider-native shape) — see below |

Adding a new all-provider behavior is one entry in `DEFAULT_TRANSFORMS` — no
engine change, no per-provider wiring.

`collectDefaults(ctx)` flattens the registry into the three bags
`engine.ts`'s `buildRoute` merges with the adapter + model bags.

### Why `thinking` filters to `ctx.providerFmt`

`defaultThinkingResponse`/`defaultThinkingStream` return tagged stages for
*all three* formats (a scanner exists per format). The default set filters
to only the stage tagged the hop's actual `providerFmt` — thinking
extraction is meant to run **once**, on the provider's native shape,
pre-bridge, exactly as the pre-refactor standalone `applyThinking`/
`thinkingStream` functions did. Including all three tagged copies would
mean a `clientFmt`-tagged copy also fires post-bridge — a wasted second pass
over an already-converted body.

### The Anthropic request-hook stack (`anthropic/hooks/stack.ts`)

`defaultAnthropicRequestHooks()` returns four ordered, `"messages"`-tagged
`onRequest` stages, each additionally gated on `ctx.providerFmt === "messages"`
(so the pre-conversion slot — a client sending Messages to a *non*-Messages
provider — stays a no-op, reproducing the historical "fires only when the
provider emits Messages" behavior exactly):

1. **`anthropic:thinking-signature`** — every `thinking` content block
   (synthetic *or* genuine) is rewritten to a signature-free `text` block
   carrying the same reasoning prose (`thinkingBlocksToText`);
   `redacted_thinking` blocks are always dropped. Runs **first** so every
   later hook sees a body with no `thinking`-typed blocks at all. This is
   unconditional — even a real Anthropic signature can't be trusted here,
   because a fallback-chain retry may route the same conversation to a
   *different* Anthropic-compatible provider that can't validate another
   provider's signature. See
   [format-conversion.md § Synthetic thinking-block signatures](./format-conversion.md#synthetic-thinking-block-signatures)
   for the full reasoning and the live-API event sequence this is
   compensating for.
2. **`anthropic:thinking-config`** — `adaptive` → `{type:"enabled",
   budget_tokens:10000}` on Haiku; floors `budget_tokens` to 1024 and keeps
   it `< max_tokens`; hoists mid-conversation `role:"system"` turns into the
   top-level `system` field.
3. **`anthropic:max-tokens`** — clamps `max_tokens` to
   `ctx.maxOutputTokens` (the hop's effective ceiling), re-shrinking
   `budget_tokens` if the clamp would breach `budget < max`.
4. **`anthropic:prefill`** — appends a trailing `user` turn (with
   `tool_result` blocks if the last turn had `tool_use`) when the
   conversation ends on `assistant` — a Claude 4.6+ prefill requirement.

Each hook is individually guarded by `applyBodyTransforms` (a throw is
caught, body passes through) and is a no-op when its trigger condition is
absent — one bad hook can't break the proxy path.

`thinkingBlocksToText` vs. `stripThinkingBlocks`
(`anthropic/hooks/thinking-signature.ts`): the stack uses the **non-lossy**
`thinkingBlocksToText` — reasoning prose survives as an ordinary text block,
invisible to Anthropic's thinking-specific signature validation but still
present for the model to read. `stripThinkingBlocks` (drops the block
outright) is exported for a caller that explicitly wants reasoning
discarded, but is **not** used by the default stack. An empty/whitespace-only
`thinking` field (the case when the producing model used
`display:"omitted"`) is dropped rather than emitted as `{type:"text",
text:""}` — the API rejects an empty text block, and there's no prose to
preserve anyway.

---

## The user-configurable transform library (`formats/transforms/registry.ts`)

Distinct from the defaults registry above: this is a catalog of **named,
parameterized, pure body transforms** a user picks and configures **per
imported model** in the UI — no code needed for the common cases. Served via
`GET /api/transforms` (`listTransformDefs()`).

```ts
interface TransformDef {
  id: string;
  label: string;
  blurb: string;
  phases: TransformPhase[];      // ["request"] | ["response"] | both
  params: ParamSpec[];            // drives the UI's config form
  build: (params: Record<string, unknown>) => BodyXform;
}
```

Built-in defs, grouped by how generic they are:

**Generic body-shape ops** (work on any JSON body via a dotted field path):
`set-field`, `set-default` (won't overwrite a client value), `delete-field`,
`rename-field`, `clamp-number`.

**Format-aware ops** (`builtins-extra.ts`):

| id | Phase | What it does |
|---|---|---|
| `anthropic-cache` | request | Adds `cache_control:{type:"ephemeral", ttl}` breakpoints to the stable prefix (last `system` block, last tool, last message) for Anthropic prompt caching. `ttl` = `5m` (default) or `1h`. **A family default for every Anthropic-native provider** (see below) — usually not picked manually; add it here explicitly only to override the `ttl` for one specific model. No-ops on a non-Anthropic-shaped body (see `looksOpenAIShaped`'s doc comment) — a real concern now that this runs unconditionally as a family default, not just when a user opted in. |
| `system-prepend` | request | Prepends a user-supplied system instruction (Anthropic `system` field or a chat system message) |
| `sanitize-tool-args` | response | Fixes malformed tool-call arguments from non-Claude models: numeric strings → numbers, clamp `Read.limit` ≤ 2000, drop negative offsets / invalid pdf `pages`. **Also a family default for every Anthropic-native provider.** |

A model's configured list (`ModelTransformConfig[]`) is resolved to actual
`RequestTransform`/`ResponseTransform` stages by `formats/transforms/apply.ts`:

```ts
buildModelTransforms(config, phase)  // -> stages for one phase
modelTransformBags(config)            // -> { request, response } bags
```

Both are defensive by design: an unknown `id` or a phase mismatch is
skipped (config can outlive library changes across an upgrade), and a
`build(params)` call or the resulting function throwing is caught and the
body passed through unchanged — a bad param set or a buggy custom transform
never breaks the request.

---

## The default provider transform stack

A **family default** is a library transform a provider's catalog adapter
declares via `quirks.defaultTransforms: ModelTransformConfig[]` — the same
shape a model's own config uses, just declared once per family instead of
picked per model in the UI. It applies to **every** provider created from
that catalog entry, and every model imported under it, automatically.

### `ANTHROPIC_DEFAULT_TRANSFORMS` — one constant, three adapters

```ts
// src/providers/catalog/anthropic-compatible.ts
export const ANTHROPIC_DEFAULT_TRANSFORMS: ModelTransformConfig[] = [
  { id: "anthropic-cache", phase: "request", params: { ttl: "5m" } },
  { id: "sanitize-tool-args", phase: "response", params: {} },
];
```

Declared **once**, on the generic `anthropic-compatible` catalog entry (the
"any endpoint speaking Anthropic Messages" escape hatch — the natural base
for the whole family), and inherited by every Anthropic-native adapter via
`quirks.defaultTransforms: ANTHROPIC_DEFAULT_TRANSFORMS`:

| Catalog id | File | Inherits the base |
|---|---|---|
| `anthropic-compatible` | `catalog/anthropic-compatible.ts` | *is* the base |
| `anthropic` | `catalog/anthropic.ts` | same array reference |
| `anthropic-subscription` | `catalog/anthropic-subscription.ts` | same array reference |

A new Anthropic-family-wide default (a new prompt-caching knob, another
correctness fix that applies to any Claude-speaking provider) is added to
`ANTHROPIC_DEFAULT_TRANSFORMS` **once** and every one of these three catalog
adapters picks it up — there is nothing to keep in sync, since all three
`quirks.defaultTransforms` fields literally point at the same array. A
provider whose family needs an *additional* default beyond the shared base
spreads it: `defaultTransforms: [...ANTHROPIC_DEFAULT_TRANSFORMS, { id:
"...", ... }]`.

OpenAI-native adapters (`openai`, `deepseek`, `glm`, `openrouter`, …) declare
no `defaultTransforms` at all — this family concept doesn't extend to them
today. `familyDefaultTransforms(provider)`/`defaultTransformsForCatalog(id)`
(`src/providers/registry.ts`) are the two read accessors — both return `[]`
for a provider whose adapter declares no `quirks.defaultTransforms`.

### `mergeTransforms` / `dropOverriddenDefaults` — family defaults as a base layer

```ts
function dropOverriddenDefaults(
  defaults: ModelTransformConfig[] | undefined,  // family defaults (adapter quirks)
  own: ModelTransformConfig[] | undefined,        // this model's own config
): ModelTransformConfig[]                         // defaults minus anything `own` overrides

function mergeTransforms(
  defaults: ModelTransformConfig[] | undefined,
  own: ModelTransformConfig[] | undefined,
): ModelTransformConfig[]                         // dropOverriddenDefaults(...) followed by `own`
```

Both dedupe by `(id, phase)`: a model's own entry overrides a family default
that declares the same transform, but any default the model *hasn't*
overridden still applies. `engine.ts`'s `buildChain` calls
`dropOverriddenDefaults` **fresh on every request** to compute the
`ChainEntry`'s `familyTransforms` (kept separate from `ownTransforms` — see
[the four transform layers](#the-four-transform-layers) — so `buildRoute` can
place family defaults *before* the adapter's own stack and the model's own
transforms *after* it). `mergeTransforms` itself is a flat convenience
(`dropOverriddenDefaults` + `own` concatenated) used where relative order
against an adapter stack doesn't matter. Either way: even a model whose own
`transforms` config is empty still gets its family's defaults, and a
family-default change (a code update, e.g. a new `ANTHROPIC_DEFAULT_TRANSFORMS`
entry) takes effect for every existing imported model immediately, with **no
re-import or migration step**.

> **Not seeded at import time.** An earlier version of this system copied
> `mergeTransforms(familyDefaults, supplied)` into a freshly-imported
> model's stored `transforms` — meaning the defaults were baked into the
> row's own editable JSON, indistinguishable from something the operator
> configured. This is deliberately **no longer done**
> (`POST /providers/:id/models` now stores only what the caller actually
> supplied). Two reasons: (1) it made a family default *look* editable in
> the UI when deleting it did nothing (`mergeTransforms` would just
> resurrect it from the live family-default computation on the next
> request — the delete silently had no effect), and (2) it meant a
> newly-added family default (like `anthropic-cache` in this change) never
> reached a model imported *before* the code change, without re-importing
> it. Since the merge already happens fresh on every request, storing a copy
> at import time was redundant *and* the source of both bugs. Existing rows
> imported under the old behavior still work exactly as before — a stored
> entry with the same `(id, phase)` as a live family default simply looks
> like an (identical) override, which `mergeTransforms` handles the same
> way it handles any other override.

### Inspecting the resolved stack — `GET /providers/:id/transforms/resolved`

The single place that answers "what does this provider actually do to a
request" — composes **all four layers**, in the exact order `engine.ts`
applies them, for the provider's own native wire format (the single-hop,
no-conversion case — see `src/admin/routes/resolved-transforms.ts`'s header
comment for the full scoping rationale):

```
GET /api/providers/:id/transforms/resolved              -> provider-level defaults
GET /api/providers/:id/transforms/resolved?upstreamId=X  -> + model X's own overrides
```

Response (`ResolvedTransforms`, `src/admin/routes/resolved-transforms.ts`):

```ts
interface ResolvedTransformStage {
  name: string;                                            // e.g. "family:anthropic-cache"
  source: "builtin" | "family" | "adapter" | "model";       // which of the 4 layers
  phase: "request" | "response" | "stream";
  label?: string;    // human name — see "Optional display metadata" above
  blurb?: string;
  params?: Record<string, unknown>;   // family/model stages only (library params)
  group?: string;    // siblings sharing this string cluster in the UI
  overridden?: boolean;  // family stages a model config replaces — see `overridden` below
}
interface ResolvedTransforms {
  providerId: string;
  catalogId: string | null;
  nativeFormat: "anthropic" | "openai";
  nativeWireKind: "chat" | "messages" | "responses";
  request: ResolvedTransformStage[];
  response: ResolvedTransformStage[];
  stream: ResolvedTransformStage[];
  overridden: ResolvedTransformStage[];  // family defaults the model config replaces
}
```

`request`/`response`/`stream` are exactly what **runs** — a family default a
model overrides does **not** appear there (its replacement, tagged
`source:"model"`, does); it appears separately in `overridden`, flagged, so
the UI can show "this model customizes X away from the family default"
without implying X still fires. `builtin`/`adapter` stages carry `label`/
`blurb`/`group` only when the declaration site set a `TransformMeta` (see
above) — falls back to a humanized `name` when absent, never a hard
requirement; `family`/`model` stages are always fully described, straight
from the transform library (`params` included). `group` (only ever set on
builtin/adapter stages today) is a pure display hint: the resolver never
merges or reorders stages because of it — the flat list always reflects
exactly what runs, in exactly the order it runs; grouping is entirely a
client-side rendering choice over that flat list.

Read-only, purely a preview — nothing posted here is ever written back. The
web UI's `<DefaultTransformsPanel>` (`web/src/components/default-transforms.tsx`)
renders this exact response as a collapsible card (same idiom as
`CapabilitiesEditor` in `models/shared.tsx` — a header row toggles the whole
thing open/closed, closed by default so it doesn't dominate the page):
grouped by phase (Request/Response/Stream), and within each phase,
consecutive stages sharing a `group` collapse into ONE nested-collapsible row
(e.g. the four Anthropic request hooks read as "Anthropic Hooks · 4 stages"
until expanded) instead of one row per stage. Every stage is shown
**non-editable** and visually separate from `<TransformEditor>` (which edits
ONLY the model's own, layer-4 config) — so "what always happens" and "what
I've customized" never look like the same kind of control. Shown at the
provider level (Models tab — the defaults every model on this provider
starts from, collapsed by default) and per imported model (the row-expander,
layered with that model's own overrides — its own compact single-line
disclosure so it doesn't push the rest of the row down before an operator
asks to see it).

---

## Adding a new transform

Four cases, matching the four layers above. **See also the file checklist**
at the very end of this document for the exact file list per case.

**1. Builtin — applies regardless of which provider serves the request.**
Add a `DefaultTransformSet` entry to `DEFAULT_TRANSFORMS` in
`formats/transforms/defaults.ts`. Author its stages with
`onRequest`/`onResponse`/`onStreamEvent`, tagged to whichever wire format(s)
the behavior needs to see.

**2. Adapter — one specific provider's own behavior.** Override
`requestTransforms`/`responseTransforms`/`streamTransforms` on that
provider's adapter (see
[provider-adapters.md](./provider-adapters.md#transform-hooks-edit-the-body-as-part-of-the-pipeline)) —
no engine or registry change needed.

**3. Family default — applies to every provider of a family (e.g. every
Anthropic-native provider), automatically, on every model imported under
it, no user action.** Two sub-cases:

- A transform doesn't exist as a library entry yet → first add it as a
  `TransformDef` (case 4 below), THEN reference its `id` from
  `quirks.defaultTransforms`.
- The library entry already exists → just add `{ id, phase, params }` to
  the relevant family constant (e.g. `ANTHROPIC_DEFAULT_TRANSFORMS` in
  `providers/catalog/anthropic-compatible.ts`) or to one catalog adapter's
  own `quirks.defaultTransforms` array if it's specific to that one
  provider, not the whole family. See **[The default provider transform
  stack](#the-default-provider-transform-stack)** above for the exact
  mechanics and the inheritance pattern (`ANTHROPIC_DEFAULT_TRANSFORMS`
  shared by three adapters via one array reference) to follow for a NEW
  family (an OpenAI-family equivalent doesn't exist today — see the file
  checklist below for what creating one from scratch would touch).

**4. User-configurable, per-model behavior — a new pick in the transform
picker.** Add a `TransformDef` to `LIBRARY` in
`formats/transforms/registry.ts`, with a `build(params)` that returns a
plain `BodyXform` (`(body: Json) => Json`). Put anything non-trivial in
`builtins-extra.ts` alongside `anthropicCache`/`systemPrepend`/
`sanitizeToolArgs`, following the same pattern: a small factory function
that closes over its parsed params and returns the actual transform. A
`BodyXform` has no `TransformCtx` — if the behavior needs to know the
provider/hop/format, it can't be a plain library transform; use case 1 or 2
(a tagged `onRequest`/`onResponse` stage) instead, which DO receive `ctx`.

In all four cases: name the stage `"namespace:short-id"`, keep it a no-op
when its trigger condition is absent, and never let it throw on a
malformed/unexpected body shape — the whole pipeline is designed so one
misbehaving stage degrades to a no-op rather than failing the request. A
library-backed transform (cases 3–4) that might run on a body it wasn't
written for (e.g. a family default running whether or not the operator
pinned the hop's endpoint away from the family's native format) needs its
OWN shape guard, since it has no `ctx.providerFmt` to gate on — see
`looksOpenAIShaped` in `builtins-extra.ts` for the pattern: check for
strong, unambiguous markers of the *other* format and no-op if found, rather
than assuming the body is shaped the way the family normally sends it.

---

## File checklist: adding a new default transformation

Exactly which files to touch, for each of the four cases above.

### Adding a new BUILTIN default (Anthropic or otherwise — applies to every
matching provider, unconditionally, no library entry)

1. Author the stage(s) — a new file under `src/formats/anthropic/hooks/` (if
   Anthropic-Messages-specific, alongside `thinking-signature.ts`/
   `thinking-config.ts`/`max-tokens.ts`) or wherever else makes sense for a
   non-Anthropic builtin default; export a plain function.
2. Wire it into the stack: `src/formats/anthropic/hooks/stack.ts`'s
   `defaultAnthropicRequestHooks()` (Anthropic-Messages case — add an
   `onRequest("messages", "anthropic:your-id", ..., meta)` entry, gated on
   `messagesOnly(ctx)` like its siblings) — or, for a non-Anthropic/
   non-request-phase builtin, add a new entry directly to
   `DEFAULT_TRANSFORMS` in `src/formats/transforms/defaults.ts`. Pass the 4th
   `meta` argument (`{ label, blurb, group }` — see [Optional display
   metadata](#optional-display-metadata-label--blurb--group) above) so the
   stage shows a friendly name in the UI instead of the raw `name`; set
   `group` to the SAME string as its siblings if the new stage always runs
   alongside them as one conceptual unit (e.g. adding a 5th Anthropic hook
   should reuse stack.ts's existing `GROUP` constant).
3. Update `docs/transforms-api.md`'s **"The Anthropic request-hook
   stack"** table (or **"The all-provider defaults registry"** table for a
   non-Anthropic-hooks builtin) with the new stage.
4. Add a unit test — `src/formats/anthropic/hooks/hooks.test.ts` (or the
   sibling test file for your new hook) asserting the gating + no-op
   behavior, mirroring the existing hooks' tests.

### Adding a new FAMILY default (e.g. a new Anthropic-family default)

1. If it needs a NEW library transform first, do that (see the LIBRARY
   checklist below), then:
2. Add `{ id, phase, params }` to `ANTHROPIC_DEFAULT_TRANSFORMS` in
   `src/providers/catalog/anthropic-compatible.ts` (Anthropic family) — every
   adapter that references this constant (`anthropic.ts`,
   `anthropic-subscription.ts`) picks it up automatically, nothing else to
   touch there. For a provider-specific (not family-wide) default instead,
   add it directly to that one catalog file's own `quirks.defaultTransforms`
   array (spread the family base first if it should still inherit the
   family's defaults too: `[...ANTHROPIC_DEFAULT_TRANSFORMS, { ... }]`).
3. If the transform's shape logic needs to defend against running on the
   WRONG format's body (see `looksOpenAIShaped`'s doc comment for why this
   matters for a family default specifically), harden the transform body
   itself in `src/formats/transforms/builtins-extra.ts`.
4. Update `docs/transforms-api.md`'s family-defaults description and the
   **Format-aware ops** table if the transform's blurb/behavior changed.
5. Add/extend a test in `src/providers/builder.test.ts` (the "every
   Anthropic-native catalog adapter inherits the SAME family default stack"
   test is the pattern to extend) and in
   `src/formats/transforms/transforms.test.ts` for the transform body itself.
6. No web/UI changes needed — `<DefaultTransformsPanel>` renders whatever
   `GET /providers/:id/transforms/resolved` reports automatically.

### Adding a new LIBRARY transform (user-configurable, opt-in per model —
also the prerequisite step for a new family default)

1. `src/formats/transforms/registry.ts` — add a `TransformDef` to `LIBRARY`
   (id/label/blurb/phases/params/build). For anything beyond a trivial
   field-path op, put the actual body-transform function in
   `src/formats/transforms/builtins-extra.ts` and import it.
2. Update `docs/transforms-api.md`'s **Format-aware ops** (or **Generic
   body-shape ops**) table.
3. Add tests to `src/formats/transforms/transforms.test.ts` (mirror the
   existing `anthropic-cache`/`system-prepend`/`sanitize-tool-args` tests).
4. No web/UI changes needed — `<TransformEditor>` reads the catalog live
   from `GET /api/transforms` (`listTransformDefs()`), so a new entry
   appears in the picker automatically.

### Adding a new ADAPTER-specific transform (one provider only)

1. Override `requestTransforms`/`responseTransforms`/`streamTransforms` on
   that provider's catalog file directly (e.g.
   `src/providers/catalog/<name>.ts`) — see
   [provider-adapters.md](./provider-adapters.md#transform-hooks-edit-the-body-as-part-of-the-pipeline).
   Pass the 4th `meta` argument to `onRequest`/`onResponse`/`onStreamEvent`
   (see [Optional display metadata](#optional-display-metadata-label--blurb--group))
   for a friendly label in the resolved-transforms UI — see
   `catalog/example-custom.ts` for the pattern on all three hook types.
2. Update that provider's section of `docs/provider-adapters.md` if it has
   one, or add a brief note in its catalog file's own header comment.
3. No web/UI changes needed — `<DefaultTransformsPanel>`'s `adapter` stages
   come from `adapter.transforms(provider)`, called live.
