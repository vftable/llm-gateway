import { OpenAICompatibleAdapter } from "./base";

// DeepSeek — OpenAI-compatible API.
export const deepseek = new OpenAICompatibleAdapter({
  id: "deepseek",
  label: "DeepSeek",
  blurb: "DeepSeek chat & reasoner models — OpenAI-compatible.",
  brand: "deepseek",
  docsUrl: "https://api-docs.deepseek.com/",
  defaults: {
    baseUrl: "https://api.deepseek.com",
    format: "openai",
    endpoints: ["/v1/chat/completions"],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    { key: "name", label: "Name", placeholder: "deepseek", required: true },
    { key: "apiKeys", label: "API key", placeholder: "sk-…", required: true },
  ],
});
