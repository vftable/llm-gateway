// Provider catalog types.
//
// The canonical shapes live in src/types.ts (so the web mirror and the
// backend agree). This file re-exports them for ergonomic imports within the
// catalog module and documents the contract in one place.

export type {
  ProviderTemplate,
  ProviderDefaults,
  ProviderQuirks,
  TemplateField,
} from "../types";
