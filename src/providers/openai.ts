import { OpenAICompatibleAdapter } from "./base";

// OpenAI official API. Bearer auth, chat + responses endpoints.
export const openai = new OpenAICompatibleAdapter({
  id: "openai",
  label: "OpenAI",
  blurb: "Official OpenAI API — GPT models, chat & responses endpoints.",
  brand: "openai",
  docsUrl: "https://platform.openai.com/docs/api-reference",
  defaults: {
    baseUrl: "https://api.openai.com",
    format: "openai",
    endpoints: ["/v1/chat/completions", "/v1/responses"],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    { key: "name", label: "Name", placeholder: "openai", required: true },
    {
      key: "apiKeys",
      label: "API key",
      placeholder: "sk-…",
      required: true,
      hint: "One per line — rotated round-robin.",
    },
  ],
});
