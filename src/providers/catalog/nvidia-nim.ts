import { OpenAICompatibleAdapter } from "../base";
import { WireKind } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

// NVIDIA NIM / build.nvidia.com — OpenAI-compatible chat endpoint, Bearer auth.
class NvidiaNimAdapter extends OpenAICompatibleAdapter {}

export const nvidiaNim = new NvidiaNimAdapter({
  id: "nvidia-nim",
  label: "NVIDIA NIM",
  blurb: "NVIDIA inference microservices — OpenAI-compatible chat endpoint.",
  brand: "nvidia",
  docsUrl: "https://docs.nvidia.com/nim/",
  defaults: {
    baseUrl: "https://integrate.api.nvidia.com",
    endpoints: [WireKind.Chat],
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
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
