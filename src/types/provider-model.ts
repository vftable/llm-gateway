// An imported upstream model, scoped to one provider. This is the per-provider
// catalog entry a chain link references by upstream_id. Never exposed on
// /v1/models — only user-authored exposed Models (with chains) are.

import type { ModelTransformConfig } from "./transforms";

export interface ProviderModel {
  id: number;
  providerId: string;
  /** The id sent upstream, e.g. "glm-4.6". */
  upstreamId: string;
  displayName: string | null;
  /** Base context window (a chain link may override this per hop). */
  contextWindow: number | null;
  maxOutputTokens: number | null;
  /** Ordered per-model transform config (from the transform library). */
  transforms: ModelTransformConfig[];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderModelInput {
  providerId: string;
  upstreamId: string;
  displayName?: string | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  transforms?: ModelTransformConfig[];
  notes?: string | null;
}
