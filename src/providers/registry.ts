// Provider registry.
//
// A TypeScript-defined catalog of known upstream providers. Each entry is a
// ProviderAdapter INSTANCE (see ./base + each file under ./catalog/) that owns
// both the catalog metadata (pre-fills the Add-Provider wizard) and the
// per-endpoint routing behavior. The engine resolves a DB provider row to its
// adapter via `adapterForProvider`.
//
// To add a provider:
//   1. Create ./catalog/<name>.ts exporting `new OpenAICompatibleAdapter({...})`
//      or `new AnthropicCompatibleAdapter({...})`. Subclass when it needs:
//        - custom body transforms (override requestTransforms/responseTransforms,
//          see ./catalog/claude-code.ts), or
//        - a fully custom outbound request — override chatCompletions/messages/
//          responses(ctx: BuildCtx): BuiltRequest to rewrite the URL (signed /
//          custom host), headers (bespoke auth from ctx.apiKey), and/or body
//          (envelopes, extra fields). The default builder forwards verbatim.
//   2. Add the instance to ADAPTERS below.
// It appears in the wizard immediately (via .toTemplate()) and routes through
// its adapter — no engine changes needed.
//
// `./catalog/` holds only the 14 stock provider entries themselves; this file
// (registry.ts), base/, quirks.ts, and types.ts are infrastructure and stay
// at the top level of providers/ — kept apart so "add a provider" always
// means "add one file to catalog/", never touching the machinery around it.

import type {
  Provider,
  ProviderTemplate,
  ModelTransformConfig,
} from "../types";
import { WireKind } from "../types";
import {
  ProviderAdapter,
  OpenAICompatibleAdapter,
  AnthropicCompatibleAdapter,
} from "./base";
import { openai } from "./catalog/openai";
import { anthropic } from "./catalog/anthropic";
import { claudeCode } from "./catalog/claude-code";
import { nvidiaNim } from "./catalog/nvidia-nim";
import { openrouter } from "./catalog/openrouter";
import { opencode } from "./catalog/opencode";
import { xiaomiMimo } from "./catalog/xiaomi-mimo";
import { deepseek } from "./catalog/deepseek";
import { glm } from "./catalog/glm";
import { gemini } from "./catalog/gemini";
import { openaiCompatible } from "./catalog/openai-compatible";
import { anthropicCompatible } from "./catalog/anthropic-compatible";
import { exampleCustom } from "./catalog/example-custom";
import { proxy } from "./catalog/proxy";
import { newapi } from "./catalog/newapi";
import { ollama, ollamaCloud } from "./catalog/ollama";

// Order here is the order shown in the catalog grid: branded stock providers
// first, generic escape-hatch templates last.
const ADAPTERS: ProviderAdapter[] = [
  openai,
  anthropic,
  claudeCode,
  nvidiaNim,
  openrouter,
  opencode,
  xiaomiMimo,
  deepseek,
  glm,
  gemini,
  openaiCompatible,
  anthropicCompatible,
  ollama,
  ollamaCloud,
  newapi,
  exampleCustom,
  proxy,
];

const ADAPTER_BY_ID: Record<string, ProviderAdapter> = Object.fromEntries(
  ADAPTERS.map((a) => [a.id, a]),
);

// Generic fallbacks for DB providers with no catalogId (or an unknown one),
// selected by the provider's own `format`.
const GENERIC_OPENAI = openaiCompatible;
const GENERIC_ANTHROPIC = anthropicCompatible;

// Ordered plain-metadata list for UI grids (unchanged API contract).
export function listProviderTemplates(): ProviderTemplate[] {
  return ADAPTERS.map((a) => a.toTemplate());
}

export function getProviderTemplate(id: string): ProviderTemplate | undefined {
  return ADAPTER_BY_ID[id]?.toTemplate();
}

export function isProviderTemplate(id: string): boolean {
  return id in ADAPTER_BY_ID;
}

export function getAdapter(id: string): ProviderAdapter | undefined {
  return ADAPTER_BY_ID[id];
}

// Resolve a DB provider row to the adapter that should route it: its catalog
// adapter when known, else a generic adapter chosen by which endpoint kinds
// the provider accepts (messages => anthropic, chat/responses => openai).
export function adapterForProvider(provider: Provider): ProviderAdapter {
  if (provider.catalogId) {
    const a = ADAPTER_BY_ID[provider.catalogId];
    if (a) return a;
  }
  return provider.endpoints.includes(WireKind.Messages)
    ? GENERIC_ANTHROPIC
    : GENERIC_OPENAI;
}

// The default per-model transforms declared by a provider's family (its catalog
// adapter's quirks.defaultTransforms). Empty when the family declares none.
// Used both to seed a newly-imported provider-model and as the always-on base
// layer at route build.
export function familyDefaultTransforms(
  provider: Provider,
): ModelTransformConfig[] {
  return adapterForProvider(provider).quirks?.defaultTransforms ?? [];
}

// Same, resolved by catalog id (for the import path, which has the id in hand).
export function defaultTransformsForCatalog(
  catalogId: string | null | undefined,
): ModelTransformConfig[] {
  if (!catalogId) return [];
  return ADAPTER_BY_ID[catalogId]?.quirks?.defaultTransforms ?? [];
}

// Re-export the adapter base classes so provider files import them from one place
// and downstream code (engine) can reference the types.
export { ProviderAdapter, OpenAICompatibleAdapter, AnthropicCompatibleAdapter };
