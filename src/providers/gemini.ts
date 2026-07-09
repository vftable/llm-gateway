import { OpenAICompatibleAdapter } from "./base";

// Google Gemini's OpenAI-compatibility surface. Unlike other OpenAI-compatible
// providers, the chat/models paths sit under /v1beta/openai rather than /v1, so
// this ships a basePath and bare-suffix endpoints. The OpenAICompatibleAdapter
// composes origin + basePath + suffix, so all inbound formats bridge to
// /v1beta/openai/chat/completions.
export const gemini = new OpenAICompatibleAdapter({
  id: "google-gemini",
  label: "Google Gemini",
  blurb: "Gemini models via Google's OpenAI-compatible endpoint.",
  brand: "gemini",
  docsUrl: "https://ai.google.dev/gemini-api/docs/openai",
  defaults: {
    baseUrl: "https://generativelanguage.googleapis.com",
    basePath: "/v1beta/openai",
    modelsPath: "/models",
    format: "openai",
    endpoints: ["/chat/completions"],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    { key: "name", label: "Name", placeholder: "gemini", required: true },
    {
      key: "apiKeys",
      label: "API key",
      placeholder: "AIza…",
      required: true,
      hint: "One per line — rotated round-robin.",
    },
  ],
});
