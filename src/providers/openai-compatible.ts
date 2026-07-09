import { OpenAICompatibleAdapter } from "./base";

// Generic OpenAI-compatible endpoint. The escape hatch for any provider that
// speaks the OpenAI chat wire format but isn't in the catalog (vLLM, Ollama,
// LM Studio, Together, Groq, Fireworks, self-hosted, …). Base URL is required.
export const openaiCompatible = new OpenAICompatibleAdapter({
  id: "openai-compatible",
  label: "OpenAI-Compatible",
  blurb: "Any endpoint speaking the OpenAI chat format — bring your own URL.",
  brand: "openai",
  defaults: {
    format: "openai",
    endpoints: ["/v1/chat/completions"],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    { key: "name", label: "Name", placeholder: "my-provider", required: true },
    {
      key: "baseUrl",
      label: "Base URL",
      placeholder: "http://localhost:8000",
      required: true,
      editable: true,
      hint: "Origin (and optional path prefix) — the gateway appends /v1/…",
    },
    {
      key: "apiKeys",
      label: "API key",
      hint: "Optional — leave blank for keyless local servers.",
    },
  ],
});
