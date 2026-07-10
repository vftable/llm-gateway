// Resolve the FULL, ordered transform stack that would apply to a provider's
// requests — the read-only "what actually happens" view the UI and API expose
// so an operator never has to reverse-engineer engine.ts to answer "what
// transforms is this provider running?"
//
// This mirrors — deliberately, stage for stage — the composition engine.ts's
// buildRoute()/buildChain() do at request time, for the SINGLE-HOP case where
// the client sends the provider's own native wire format (no client<->provider
// bridge, so every format-tagged stage that fires on this provider fires here
// too, and nothing else does — see buildTransformPlan's placement rule in
// docs/transforms-api.md). A provider whose actual traffic crosses formats
// (e.g. a Chat client hitting an Anthropic-native provider) sees exactly the
// same stages; only their order relative to the client<->provider conversion
// shifts, which this preview intentionally doesn't model — the resolved list
// answers "what does this provider apply", not "what does this ONE hop's
// bridge look like".
//
// Four layers, in the exact order buildRoute assembles them:
//   1. builtin   — the all-provider registry (formats/transforms/defaults.ts):
//                  Anthropic request hooks + <thinking> extraction. Always the
//                  same for every provider of a given native format. Not
//                  ModelTransformConfig-backed (it's hand-authored pipeline
//                  code), but MAY carry optional label/blurb/group display
//                  metadata set at the declaration site (see TransformMeta in
//                  formats/pipeline.ts) — falls back to a humanized stage name
//                  in the UI when unset.
//   2. family    — quirks.defaultTransforms declared on the catalog adapter
//                  (e.g. ANTHROPIC_DEFAULT_TRANSFORMS). Backed by the transform
//                  LIBRARY, so these carry full label/blurb/params metadata
//                  from the library definition itself (registry.ts). Runs
//                  BEFORE the adapter's own stack — e.g. Anthropic prompt-
//                  caching breakpoints are already in place by the time an
//                  adapter-specific stage (anthropic-subscription's hooks)
//                  inspects/rewrites the body.
//   3. adapter   — this provider's own requestTransforms()/responseTransforms()/
//                  streamTransforms() override (e.g. anthropic-subscription's
//                  no-op stack, example-custom's stamps). Same optional
//                  label/blurb/group as builtin stages.
//   4. model     — the imported provider-model's OWN transforms config (only
//                  present when resolving for a specific upstream id). A model
//                  entry whose (id, phase) matches a family entry OVERRIDES it
//                  — the family entry is dropped from the list, exactly as
//                  dropOverriddenDefaults does at request time — so what's
//                  shown is what actually runs, never a stage that would be
//                  shadowed. Runs LAST, so an operator's explicit per-model
//                  customization always has the final say.
//
// `group`: when multiple stages in the SAME phase+source share a `group`
// string (set at the declaration site — see the four Anthropic request hooks
// in anthropic/hooks/stack.ts, all tagged group:"anthropic-hooks"), the UI
// clusters them under one collapsible row instead of showing each
// separately. Grouping is purely a display concern computed by the CALLER
// (the web UI) from the flat stage list this module returns — stages are
// never merged or reordered here, so the resolved list always reflects
// exactly what runs, in exactly the order it runs.
//
// This module is pure/DB-agnostic (the route handler fetches the provider-model
// row and passes its transforms in) so it's directly unit-testable.

import {
  adapterForProvider,
  familyDefaultTransforms,
  type WireFmt,
} from "../../providers";
import { getTransformDef } from "../../formats/transforms";
import { collectDefaults } from "../../formats/transforms/defaults";
import { ThinkingConverter } from "../../formats/thinking";
import type {
  Provider,
  ModelTransformConfig,
  TransformPhase,
} from "../../types";
import { WireKind } from "../../types";

// One resolved stage — a single unit in the ordered list the UI renders.
// `source` is what makes this endpoint useful for "how do adapters build on
// each other": everything downstream of `builtin` is layered ON TOP of what
// came before, in the same order it's shown.
export type TransformSource = "builtin" | "family" | "adapter" | "model";

// A resolved stage's phase — widens the library's request/response
// TransformPhase with "stream" (SSE stages have no library/model-config
// equivalent, so TransformPhase itself deliberately doesn't include it, but
// this preview needs to describe all three buckets uniformly).
export type ResolvedPhase = TransformPhase | "stream";

export interface ResolvedTransformStage {
  /** Stage name as it appears in the debug transform trace (e.g.
   *  "anthropic:thinking-signature", "model:anthropic-cache"). */
  name: string;
  source: TransformSource;
  phase: ResolvedPhase;
  /** Human label — from the library definition (family/model stages) or the
   *  declaration site's optional TransformMeta (builtin/adapter stages). The
   *  UI falls back to a humanized `name` when this is absent. */
  label?: string;
  blurb?: string;
  params?: Record<string, unknown>;
  /** When set, this stage clusters with any SIBLING of the same phase+source
   *  sharing the same `group` string under one collapsible UI row (see this
   *  file's header comment). Only ever set on builtin/adapter stages today
   *  (family/model stages don't declare one). */
  group?: string;
  /** True for a `family` stage the model's OWN config overrides — included so
   *  the UI can show "would apply, but this model overrides it" instead of
   *  silently omitting it (kept OUT of the flat `request`/`response`/`stream`
   *  arrays below, which reflect what actually runs). */
  overridden?: boolean;
}

export interface ResolvedTransforms {
  providerId: string;
  catalogId: string | null;
  /** The adapter's native wire format — the single-hop case this resolves for. */
  nativeFormat: "anthropic" | "openai";
  nativeWireKind: WireFmt;
  request: ResolvedTransformStage[];
  response: ResolvedTransformStage[];
  stream: ResolvedTransformStage[];
  /** Family-default stages the model's own config overrides (id+phase match) —
   *  not present in request/response above; surfaced so an operator can see
   *  what they've customized away from the family default. Empty when no
   *  `ownTransforms` was given (provider-level resolution) or nothing overlaps. */
  overridden: ResolvedTransformStage[];
}

const key = (id: string, phase: TransformPhase) => `${id}:${phase}`;

// Enrich a family/model ModelTransformConfig entry with its library metadata
// (label/blurb) when the id is still a known library transform — defensive,
// same as buildModelTransforms: an id the library no longer has still shows,
// just without the rich label (config can outlive library changes).
function describe(
  c: ModelTransformConfig,
  source: "family" | "model",
): ResolvedTransformStage {
  const def = getTransformDef(c.id);
  return {
    name: `${source}:${c.id}`,
    source,
    phase: c.phase,
    label: def?.label ?? c.id,
    blurb: def?.blurb,
    params: c.params,
  };
}

// Resolve the full stack for one provider, optionally layering a specific
// imported model's own transforms on top (pass `ownTransforms` — fetch it via
// getProviderModel/getProviderModelById in the route handler; omit it to see
// just the provider-level defaults every model on this provider starts from).
export function resolveProviderTransforms(
  provider: Provider,
  ownTransforms?: ModelTransformConfig[],
): ResolvedTransforms {
  const adapter = adapterForProvider(provider);
  const nativeFormat = adapter.nativeFormat;
  const nativeWireKind: WireFmt =
    nativeFormat === "anthropic" ? WireKind.Messages : WireKind.Chat;

  // Same collection call engine.ts's buildRoute makes; a fresh ThinkingConverter
  // is fine here (it's stateless — see gateway/router.ts's own instantiation).
  const defaults = collectDefaults({
    thinking: new ThinkingConverter(),
    providerFmt: nativeWireKind,
  });
  const adapterBag = adapter.transforms(provider);

  // Single-hop, no-conversion case: every stage tagged the native format (or
  // untagged) survives; nothing else does — see this file's header comment.
  const keepsNative = (fmt?: WireFmt) =>
    fmt === undefined || fmt === nativeWireKind;
  const builtinReq = defaults.request.filter((t) =>
    keepsNative((t as { format?: WireFmt }).format),
  );
  const builtinResp = defaults.response.filter((t) =>
    keepsNative((t as { format?: WireFmt }).format),
  );
  const builtinStream = defaults.stream.filter((t) =>
    keepsNative((t as { format?: WireFmt }).format),
  );
  const adapterReq = (adapterBag.request ?? []).filter((t) =>
    keepsNative((t as { format?: WireFmt }).format),
  );
  const adapterResp = (adapterBag.response ?? []).filter((t) =>
    keepsNative((t as { format?: WireFmt }).format),
  );
  const adapterStream = (adapterBag.stream ?? []).filter((t) =>
    keepsNative((t as { format?: WireFmt }).format),
  );

  const family = familyDefaultTransforms(provider);
  const own = ownTransforms ?? [];
  const ownKeys = new Set(own.map((t) => key(t.id, t.phase)));
  const familyKept = family.filter((f) => !ownKeys.has(key(f.id, f.phase)));
  const familyOverridden = family.filter((f) =>
    ownKeys.has(key(f.id, f.phase)),
  );

  const byPhase = (phase: TransformPhase) => ({
    family: familyKept
      .filter((f) => f.phase === phase)
      .map((f) => describe(f, "family")),
    model: own
      .filter((o) => o.phase === phase)
      .map((o) => describe(o, "model")),
  });
  const reqLib = byPhase("request");
  const respLib = byPhase("response");

  return {
    providerId: provider.id,
    catalogId: provider.catalogId,
    nativeFormat,
    nativeWireKind,
    request: [
      ...builtinReq.map((t) => stageOf(t, "builtin", "request")),
      ...reqLib.family,
      ...adapterReq.map((t) => stageOf(t, "adapter", "request")),
      ...reqLib.model,
    ],
    response: [
      ...builtinResp.map((t) => stageOf(t, "builtin", "response")),
      ...respLib.family,
      ...adapterResp.map((t) => stageOf(t, "adapter", "response")),
      ...respLib.model,
    ],
    stream: [
      ...builtinStream.map((t) => stageOf(t, "builtin", "stream")),
      ...adapterStream.map((t) => stageOf(t, "adapter", "stream")),
    ],
    overridden: familyOverridden.map((f) => ({
      ...describe(f, "family"),
      overridden: true,
    })),
  };
}

// A builtin/adapter stage is hand-authored pipeline code (onRequest/onResponse/
// onStreamEvent or a legacy untagged transform) — no library metadata, but it
// MAY carry the optional label/blurb/group TransformMeta set at its
// declaration site (see formats/pipeline.ts); pass it through when present.
function stageOf(
  t: { name: string; label?: string; blurb?: string; group?: string },
  source: "builtin" | "adapter",
  phase: ResolvedPhase,
): ResolvedTransformStage {
  return {
    name: t.name,
    source,
    phase,
    label: t.label,
    blurb: t.blurb,
    group: t.group,
  };
}
