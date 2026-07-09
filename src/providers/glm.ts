import { OpenAICompatibleAdapter } from "./base";

// Z.ai GLM Coding Plan — OpenAI-compatible, but the chat/models paths sit under
// a deep prefix (/api/coding/paas/v4), not /v1. The adapter composes
//   origin + basePath + suffix
// so the upstream URL builds as:
//   https://api.z.ai + /api/coding/paas/v4 + /chat/completions
//   => https://api.z.ai/api/coding/paas/v4/chat/completions
export const glm = new OpenAICompatibleAdapter({
  id: "glm-coding",
  label: "GLM Coding Plan (Z.ai)",
  blurb: "Z.ai GLM coding-plan models — OpenAI-compatible under /api/coding/paas/v4.",
  brand: "zai",
  docsUrl: "https://docs.z.ai/",
  defaults: {
    baseUrl: "https://api.z.ai",
    basePath: "/api/coding/paas/v4",
    modelsPath: "/models",
    format: "openai",
    endpoints: ["/chat/completions"],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    { key: "name", label: "Name", placeholder: "glm-coding", required: true },
    {
      key: "apiKeys",
      label: "API key",
      placeholder: "…",
      required: true,
      hint: "One per line — rotated round-robin.",
    },
    {
      key: "baseUrl",
      label: "Base URL",
      editable: true,
      hint: "Origin only — the /api/coding/paas/v4 prefix is added automatically.",
    },
  ],
});
