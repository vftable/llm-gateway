import { AnthropicCompatibleAdapter } from "../base";
import { WireKind, type ModelTransformConfig } from "../../types";

// The Anthropic-FAMILY default transform stack — the base every Anthropic-
// native catalog adapter inherits (anthropic.ts, anthropic-subscription.ts),
// so a new family-wide default is declared here ONCE and every subclass gets
// it automatically, instead of copy-pasted per adapter. A generic/unknown
// Anthropic-compatible provider (this file) gets exactly this same base — no
// provider-specific additions — which is also why it's the natural home for
// the shared constant rather than a one-off inside anthropic.ts.
//
// Applied two ways (see providers/registry.ts familyDefaultTransforms +
// formats/transforms/apply.ts mergeTransforms):
//   1. As an always-on BASE layer at every request (engine.ts buildChain) —
//      recomputed fresh per request, so a change here takes effect for every
//      provider on this family without re-importing a single model.
//   2. Seeded (read-only in the UI, NOT written into a model's own editable
//      config — see docs/transforms-api.md) as the "Defaults" a freshly
//      imported model shows before any of the operator's own customization.
//
// Both entries only ever act on an Anthropic-Messages-shaped body — each
// transform's own shape guard (anthropicCache: system/tools/messages field
// checks; sanitizeToolArgs: Anthropic tool_use vs OpenAI tool_calls shape) is
// the actual safety net, since a provider's own `format`/`endpoints` can't be
// statically trusted (an operator can still pin an unrelated endpoint).
//
//   - anthropic-cache: ephemeral prompt-caching breakpoints (system/tools/last
//     message), 5m TTL — Anthropic's own recommended default for
//     conversational traffic. Request phase; a no-op on a non-Anthropic body.
//   - sanitize-tool-args: repairs malformed tool-call arguments a non-Claude
//     upstream can emit in a mixed fallback chain, so Claude-shaped tool
//     calls stay valid. Response phase; a no-op when args are already clean.
export const ANTHROPIC_DEFAULT_TRANSFORMS: ModelTransformConfig[] = [
  { id: "anthropic-cache", phase: "request", params: { ttl: "5m" } },
  { id: "sanitize-tool-args", phase: "response", params: {} },
];

// Generic Anthropic-compatible endpoint. For any provider speaking the
// Anthropic /v1/messages wire format but not in the catalog. Base URL required.
class AnthropicCompatibleGenericAdapter extends AnthropicCompatibleAdapter {}

export const anthropicCompatible = new AnthropicCompatibleGenericAdapter({
  id: "anthropic-compatible",
  label: "Anthropic-compatible",
  blurb: "Any endpoint speaking the Anthropic /v1/messages format.",
  brand: "anthropic",
  defaults: {
    format: "anthropic",
    endpoints: [WireKind.Messages],
    authScheme: "xapikey",
    nativeConversion: false,
    extraHeaders: { "anthropic-version": "2023-06-01" },
  },
  fields: [
    { key: "name", label: "Name", placeholder: "my-provider", required: true },
    {
      key: "baseUrl",
      label: "Base URL",
      placeholder: "http://localhost:4000",
      required: true,
      editable: true,
      hint: "Origin (and optional path prefix) — the gateway appends /v1/messages",
    },
    { key: "apiKeys", label: "API key", hint: "Optional for keyless servers." },
  ],
  quirks: {
    requiredHeaders: { "anthropic-version": "2023-06-01" },
    defaultTransforms: ANTHROPIC_DEFAULT_TRANSFORMS,
  },
});
