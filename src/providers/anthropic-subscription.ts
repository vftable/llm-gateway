// Anthropic (subscription) provider — the home of the vsllm request stack.
//
// Same upstream as the official Anthropic provider (/v1/messages), but its
// adapter wires in the subscription request-processing stack from
// formats/anthropic/subscription.ts. That stack is a documented NO-OP framework:
// the pipeline stages exist and are registered 1:1 with vsllm, but the
// attestation/billing bodies are intentionally not implemented (see that file).
//
// Adding real behavior later means filling in those transforms — nothing in the
// engine or pipeline needs to change.

import { AnthropicCompatibleAdapter } from "./base";
import type { RequestTransform } from "../formats/pipeline";
import { subscriptionRequestStack } from "../formats/anthropic/subscription";
import type { Provider } from "../types";

class AnthropicSubscriptionAdapter extends AnthropicCompatibleAdapter {
  // Custom request stages, appended after the built-in format conversion.
  requestTransforms(_p: Provider): RequestTransform[] {
    return subscriptionRequestStack;
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
    format: "anthropic",
    endpoints: ["/v1/messages"],
    authScheme: "xapikey",
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
  },
});
