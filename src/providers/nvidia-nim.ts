import { OpenAICompatibleAdapter } from "./base";

// NVIDIA NIM / build.nvidia.com — OpenAI-compatible chat endpoint, Bearer auth.
export const nvidiaNim = new OpenAICompatibleAdapter({
  id: "nvidia-nim",
  label: "NVIDIA NIM",
  blurb: "NVIDIA inference microservices — OpenAI-compatible chat endpoint.",
  brand: "nvidia",
  docsUrl: "https://docs.nvidia.com/nim/",
  defaults: {
    baseUrl: "https://integrate.api.nvidia.com",
    format: "openai",
    endpoints: ["/v1/chat/completions"],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    { key: "name", label: "Name", placeholder: "nvidia-nim", required: true },
    {
      key: "apiKeys",
      label: "API key",
      placeholder: "nvapi-…",
      required: true,
    },
    {
      key: "baseUrl",
      label: "Base URL",
      editable: true,
      hint: "Change for a self-hosted NIM container (e.g. http://localhost:8000).",
    },
  ],
});
