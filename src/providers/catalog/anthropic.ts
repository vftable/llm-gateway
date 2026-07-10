import { AnthropicCompatibleAdapter } from "../base";
import { WireKind } from "../../types";
import { ANTHROPIC_DEFAULT_TRANSFORMS } from "./anthropic-compatible";

// Anthropic official API. x-api-key auth, /v1/messages, requires the
// anthropic-version header on every request.
class AnthropicAdapter extends AnthropicCompatibleAdapter {}

export const anthropic = new AnthropicAdapter({
  id: "anthropic",
  label: "Anthropic",
  blurb: "Official Anthropic API — Claude models via /v1/messages.",
  brand: "anthropic",
  docsUrl: "https://docs.anthropic.com/en/api",
  defaults: {
    baseUrl: "https://api.anthropic.com",
    endpoints: [WireKind.Messages],
    authScheme: "xapikey",
    nativeConversion: false,
    extraHeaders: { "anthropic-version": "2023-06-01" },
  },
  fields: [
    { key: "name", label: "Name", placeholder: "anthropic", required: true },
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
    // Inherits the Anthropic-family base (prompt caching + tool-arg sanitize)
    // from anthropic-compatible.ts — see ANTHROPIC_DEFAULT_TRANSFORMS's own
    // doc comment. The official API has no additional defaults beyond the
    // shared base today; add provider-specific entries here (spread the base
    // first so a provider-specific entry with the same id+phase overrides it)
    // if that ever changes.
    defaultTransforms: ANTHROPIC_DEFAULT_TRANSFORMS,
  },
});
