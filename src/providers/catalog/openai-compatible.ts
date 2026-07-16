import {
  OpenAICompatibleAdapter,
  type BuildCtx,
  type BuiltRequest,
} from "../base";
import { WireKind } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";
import { inspect } from "node:util";

// Generic OpenAI-compatible endpoint. The escape hatch for any provider that
// speaks the OpenAI chat wire format but isn't in the catalog (vLLM, Ollama,
// LM Studio, Together, Groq, Fireworks, self-hosted, …). Base URL is required.
class OpenAICompatibleGenericAdapter extends OpenAICompatibleAdapter {
  chatCompletions(ctx: BuildCtx): BuiltRequest {
    const built = super.chatCompletions(ctx);
    console.log(
      "[openai-compatible] chatCompletions body:",
      inspect(built.body, { depth: null, colors: true }),
    );
    return built;
  }

  responses(ctx: BuildCtx): BuiltRequest {
    const built = super.responses(ctx);
    console.log(
      "[openai-compatible] responses body:",
      inspect(built.body, { depth: null, colors: true }),
    );
    return built;
  }
}

export const openaiCompatible = new OpenAICompatibleGenericAdapter({
  id: "openai-compatible",
  label: "OpenAI-compatible",
  blurb: "Any endpoint speaking the OpenAI chat format — bring your own URL.",
  brand: "openai",
  defaults: {
    format: "openai",
    endpoints: [WireKind.Chat],
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
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
