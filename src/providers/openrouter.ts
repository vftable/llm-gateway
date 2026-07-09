import { OpenAICompatibleAdapter } from "./base";

// OpenRouter — aggregates many providers behind one OpenAI-compatible API.
// Note the /api path prefix in the base URL.
export const openrouter = new OpenAICompatibleAdapter({
  id: "openrouter",
  label: "OpenRouter",
  blurb: "Unified access to hundreds of models — OpenAI-compatible.",
  brand: "openrouter",
  docsUrl: "https://openrouter.ai/docs",
  defaults: {
    baseUrl: "https://openrouter.ai/api",
    format: "openai",
    endpoints: ["/v1/chat/completions"],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    { key: "name", label: "Name", placeholder: "openrouter", required: true },
    {
      key: "apiKeys",
      label: "API key",
      placeholder: "sk-or-…",
      required: true,
    },
  ],
});
