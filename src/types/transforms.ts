// Per-model transform configuration.
//
// A model (specifically an imported provider-model) can carry an ordered list of
// transforms drawn from the built-in transform library (see
// src/formats/transforms/). Each entry names a library transform, a phase
// (request = pre-upstream body, response = post-upstream buffered body), and the
// parameters that library transform declared. Stored as JSON on the
// provider_models row; resolved into pipeline stages at request time.

export type TransformPhase = "request" | "response";

export interface ModelTransformConfig {
  /** Library transform id, e.g. "clamp-number". */
  id: string;
  phase: TransformPhase;
  /** Parameter values keyed by the library transform's ParamSpec keys. */
  params: Record<string, unknown>;
}

// --- Library definition shapes (what GET /api/transforms returns) ------------

export type ParamType = "string" | "number" | "boolean";

export interface ParamSpec {
  key: string;
  label: string;
  type: ParamType;
  required?: boolean;
  placeholder?: string;
  hint?: string;
}

// The UI-facing description of a library transform (no build fn — that's backend).
// `phases` lists which phases the transform may be used in (body-shape ops work
// in both request and response).
export interface TransformDefInfo {
  id: string;
  label: string;
  blurb: string;
  phases: TransformPhase[];
  params: ParamSpec[];
}
