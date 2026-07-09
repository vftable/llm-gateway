import { AnthropicCompatibleAdapter } from "./base";

// Anthropic official API. x-api-key auth, /v1/messages, requires the
// anthropic-version header on every request.
export const anthropic = new AnthropicCompatibleAdapter({
  id: "anthropic",
  label: "Anthropic",
  blurb: "Official Anthropic API — Claude models via /v1/messages.",
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
  },
});
