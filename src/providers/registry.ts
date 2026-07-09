// Provider registry.
//
// A TypeScript-defined catalog of known upstream providers. Each entry is a
// ProviderAdapter INSTANCE (see ./base + each provider file) that owns both the
// catalog metadata (pre-fills the Add-Provider wizard) and the per-endpoint
// routing behavior. The engine resolves a DB provider row to its adapter via
// `adapterForProvider`.
//
// To add a provider:
//   1. Create ./<name>.ts exporting `new OpenAICompatibleAdapter({...})` or
//      `new AnthropicCompatibleAdapter({...})` — or a subclass when it needs
//      custom transforms (see ./anthropic-subscription.ts).
//   2. Add the instance to ADAPTERS below.
// It appears in the wizard immediately (via .toTemplate()) and routes through
// its adapter — no engine changes needed.

import type { Provider, ProviderTemplate } from "../types";
import {
  ProviderAdapter,
  OpenAICompatibleAdapter,
  AnthropicCompatibleAdapter,
} from "./base";
import { openai } from "./openai";
import { anthropic } from "./anthropic";
import { anthropicSubscription } from "./anthropic-subscription";
import { nvidiaNim } from "./nvidia-nim";
import { openrouter } from "./openrouter";
import { opencode } from "./opencode";
import { xiaomiMimo } from "./xiaomi-mimo";
import { deepseek } from "./deepseek";
import { glm } from "./glm";
import { gemini } from "./gemini";
import { openaiCompatible } from "./openai-compatible";
import { anthropicCompatible } from "./anthropic-compatible";
import { proxy } from "./proxy";

// Order here is the order shown in the catalog grid: branded stock providers
// first, generic escape-hatch templates last.
const ADAPTERS: ProviderAdapter[] = [
  openai,
  anthropic,
  anthropicSubscription,
  nvidiaNim,
  openrouter,
  opencode,
  xiaomiMimo,
  deepseek,
  glm,
  gemini,
  openaiCompatible,
  anthropicCompatible,
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
// adapter when known, else a generic adapter chosen by wire format.
export function adapterForProvider(provider: Provider): ProviderAdapter {
  if (provider.catalogId) {
    const a = ADAPTER_BY_ID[provider.catalogId];
    if (a) return a;
  }
  return provider.format === "anthropic" ? GENERIC_ANTHROPIC : GENERIC_OPENAI;
}

// Back-compat alias (some call sites used PROVIDER_TEMPLATES as a lookup map).
export const PROVIDER_TEMPLATES: Record<string, ProviderTemplate> =
  Object.fromEntries(ADAPTERS.map((a) => [a.id, a.toTemplate()]));

// Re-export the adapter base classes so provider files import them from one place
// and downstream code (engine) can reference the types.
export {
  ProviderAdapter,
  OpenAICompatibleAdapter,
  AnthropicCompatibleAdapter,
};
