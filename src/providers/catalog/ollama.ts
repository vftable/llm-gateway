import { OpenAICompatibleAdapter } from "../base";
import { WireKind } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

class OllamaLocalAdapter extends OpenAICompatibleAdapter {}
class OllamaCloudAdapter extends OpenAICompatibleAdapter {}

// Ollama (local) — self-hosted Ollama instance, OpenAI-compatible.
export const ollama = new OllamaLocalAdapter({
  id: "ollama",
  label: "Ollama",
  blurb: "Self-hosted Ollama instance — local open-weight models.",
  brand: "ollama",
  defaults: {
    baseUrl: "http://localhost:11434",
    endpoints: [WireKind.Chat],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    { key: "name", label: "Name", placeholder: "ollama", required: true },
    {
      key: "baseUrl",
      label: "Base URL",
      placeholder: "http://localhost:11434",
      required: true,
      editable: true,
      hint: "Your Ollama instance origin — the gateway appends /v1/chat/completions.",
    },
    {
      key: "apiKeys",
      label: "API key",
      hint: "Usually not needed for local Ollama.",
    },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});

// Ollama Cloud — hosted Ollama API.
export const ollamaCloud = new OllamaCloudAdapter({
  id: "ollama-cloud",
  label: "Ollama Cloud",
  blurb: "Ollama Cloud — hosted open models via the OpenAI-compatible API.",
  brand: "ollama",
  defaults: {
    baseUrl: "https://ollama.com",
    endpoints: [WireKind.Chat],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    {
      key: "name",
      label: "Name",
      placeholder: "ollama-cloud",
      required: true,
    },
    {
      key: "apiKeys",
      label: "API key",
      placeholder: "ollama-…",
      required: true,
    },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
