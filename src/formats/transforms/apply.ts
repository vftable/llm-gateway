// Resolve a model's transform config into pipeline stages.
//
// Each ModelTransformConfig names a library transform + a phase + params. This
// turns a list of them into RequestTransform[] / ResponseTransform[] the engine
// appends to the plan (via buildTransformPlan's `extra` bag). Unknown ids and
// mismatched phases are skipped defensively (config outlives library changes).

import type {
  ModelTransformConfig,
  TransformPhase,
} from "../../types";
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
export function modelTransformBags(config: ModelTransformConfig[] | undefined): {
  request: RequestTransform[];
  response: ResponseTransform[];
} {
  return {
    request: buildModelTransforms(config, "request") as RequestTransform[],
    response: buildModelTransforms(config, "response") as ResponseTransform[],
  };
}
