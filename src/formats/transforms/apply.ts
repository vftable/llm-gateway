// Resolve a model's transform config into pipeline stages.
//
// Each ModelTransformConfig names a library transform + a phase + params. This
// turns a list of them into RequestTransform[] / ResponseTransform[] the engine
// appends to the plan (via buildTransformPlan's `extra` bag). Unknown ids and
// mismatched phases are skipped defensively (config outlives library changes).

import type { ModelTransformConfig, TransformPhase } from "../../types";
import type { RequestTransform, ResponseTransform } from "../pipeline";
import { getTransformDef } from "./registry";

export function buildModelTransforms(
  config: ModelTransformConfig[] | undefined,
  phase: TransformPhase,
): Array<RequestTransform | ResponseTransform> {
  if (!config?.length) return [];
  const out: Array<RequestTransform | ResponseTransform> = [];
  for (const c of config) {
    if (c.phase !== phase) continue;
    const def = getTransformDef(c.id);
    if (!def || !def.phases.includes(phase)) continue;
    let fn;
    try {
      fn = def.build(c.params ?? {});
    } catch {
      continue; // a bad param set shouldn't break the request
    }
    out.push({
      name: `model:${c.id}`,
      apply: (body) => {
        try {
          return fn(body);
        } catch {
          return body; // never let a transform crash the proxy path
        }
      },
    });
  }
  return out;
}

// Split a model's full config into the request + response stage bags the engine
// merges with adapter transforms.
export function modelTransformBags(
  config: ModelTransformConfig[] | undefined,
): {
  request: RequestTransform[];
  response: ResponseTransform[];
} {
  return {
    request: buildModelTransforms(config, "request") as RequestTransform[],
    response: buildModelTransforms(config, "response") as ResponseTransform[],
  };
}

// Drop any family-default entry a model's own config overrides (same id+phase
// — the model's entry wins). Shared by mergeTransforms (single flat list, used
// where relative order between family/own doesn't matter) and buildRoute
// (which keeps the two lists separate so it can place family transforms BEFORE
// the adapter's own stack and own transforms AFTER — see engine.ts buildRoute).
export function dropOverriddenDefaults(
  defaults: ModelTransformConfig[] | undefined,
  own: ModelTransformConfig[] | undefined,
): ModelTransformConfig[] {
  const ownList = own ?? [];
  const key = (t: ModelTransformConfig) => `${t.id}:${t.phase}`;
  const ownKeys = new Set(ownList.map(key));
  return (defaults ?? []).filter((d) => !ownKeys.has(key(d)));
}

// Merge a family-default transform list UNDER a model's own list: defaults form
// the base layer, but a model entry with the same (id, phase) overrides the
// default (the model's config wins). Order: surviving defaults first (base),
// then the model's own entries. Used for seeding at import time (where a flat
// ModelTransformConfig[] is the right shape); route build keeps family/own
// separate instead (see buildRoute) so family defaults can be placed ahead of
// the adapter's own transform stack.
export function mergeTransforms(
  defaults: ModelTransformConfig[] | undefined,
  own: ModelTransformConfig[] | undefined,
): ModelTransformConfig[] {
  return [...dropOverriddenDefaults(defaults, own), ...(own ?? [])];
}
