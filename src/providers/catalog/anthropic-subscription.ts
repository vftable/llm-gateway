// Anthropic (subscription) provider — the home of the vsllm request stack.
//
// Same upstream as the official Anthropic provider (/v1/messages), but its
// adapter wires in the subscription request-processing stack from
// formats/anthropic/subscription/index.ts. That stack is a documented NO-OP framework:
// the pipeline stages exist and are registered 1:1 with vsllm, but the
// attestation/billing bodies are intentionally not implemented (see that file).
//
// Adding real behavior later means filling in those transforms — nothing in the
// engine or pipeline needs to change.

import { AnthropicCompatibleAdapter } from "../base";
import type { RequestTransform } from "../../formats/pipeline";
import { subscriptionRequestStack } from "../../formats/anthropic/subscription/index";
import { WireKind, type Provider } from "../../types";
import { ANTHROPIC_DEFAULT_TRANSFORMS } from "./anthropic-compatible";

class AnthropicSubscriptionAdapter extends AnthropicCompatibleAdapter {
  // Provider-scoped subscription no-op stack. The format-driven Anthropic hooks
  // (thinking-config, max_tokens, prefill) are injected by the engine ahead of
  // these whenever the hop emits the Messages format — so this only needs to add
  // the subscription stages (concatenated after any base adapter transforms).
  requestTransforms(p: Provider): RequestTransform[] {
    return [...super.requestTransforms(p), ...subscriptionRequestStack];
  }
}

export const anthropicSubscription = new AnthropicSubscriptionAdapter({
  id: "anthropic-subscription",
  label: "Anthropic (Subscription)",
  blurb:
    "Anthropic Messages endpoint with the subscription request stack (no-op framework).",
  brand: "anthropic",
  docsUrl: "https://docs.anthropic.com/en/api",
  defaults: {
    baseUrl: "https://api.anthropic.com",
    endpoints: [WireKind.Messages],
    authScheme: "bearer",
    nativeConversion: false,
    extraHeaders: { "anthropic-version": "2023-06-01" },
  },
  fields: [
    {
      key: "name",
      label: "Name",
      placeholder: "anthropic-subscription",
      required: true,
    },
    {
      key: "apiKeys",
      label: "API key",
      placeholder: "sk-ant-…",
      required: true,
      hint: "One per line — rotated round-robin.",
    },
  ],
  quirks: {
    requiredHeaders: { "anthropic-version": "2023-06-01" },
    thinking: { defaultType: "adaptive", supportsEffort: true },
    // Same Anthropic-family base as anthropic.ts — see
    // ANTHROPIC_DEFAULT_TRANSFORMS's doc comment in anthropic-compatible.ts.
    // The subscription no-op stack (subscriptionRequestStack, above) is a
    // separate untagged requestTransforms() addition, not a quirks default —
    // it has no ModelTransformConfig shape (no library transform backs it),
    // so it can't be seeded/shown the same way; it still appears in the
    // resolved-transforms view as an adapter-level stage (see
    // docs/transforms-api.md).
    defaultTransforms: ANTHROPIC_DEFAULT_TRANSFORMS,
  },
});
