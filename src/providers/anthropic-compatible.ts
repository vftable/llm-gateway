import { AnthropicCompatibleAdapter } from "./base";

// Generic Anthropic-compatible endpoint. For any provider speaking the
// Anthropic /v1/messages wire format but not in the catalog. Base URL required.
export const anthropicCompatible = new AnthropicCompatibleAdapter({
  id: "anthropic-compatible",
  label: "Anthropic-Compatible",
  blurb: "Any endpoint speaking the Anthropic /v1/messages format.",
  brand: "anthropic",
  defaults: {
    format: "anthropic",
    endpoints: ["/v1/messages"],
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
  },
});
