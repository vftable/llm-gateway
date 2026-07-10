import { OpenAICompatibleAdapter } from "../base";
import { WireKind } from "../../types";

// OpenRouter — aggregates many providers behind one OpenAI-compatible API.
// Note the /api path prefix in the base URL.
class OpenRouterAdapter extends OpenAICompatibleAdapter {}

export const openrouter = new OpenRouterAdapter({
  id: "openrouter",
  label: "OpenRouter",
  blurb: "Unified access to hundreds of models — OpenAI-compatible.",
  brand: "openrouter",
  docsUrl: "https://openrouter.ai/docs",
  defaults: {
    baseUrl: "https://openrouter.ai/api",
    endpoints: [WireKind.Chat],
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
