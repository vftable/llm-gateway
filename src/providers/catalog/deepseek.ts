import { OpenAICompatibleAdapter } from "../base";
import { WireKind } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

// DeepSeek — OpenAI-compatible API.
class DeepSeekAdapter extends OpenAICompatibleAdapter {}

export const deepseek = new DeepSeekAdapter({
  id: "deepseek",
  label: "DeepSeek",
  blurb: "DeepSeek chat & reasoner models — OpenAI-compatible.",
  brand: "deepseek",
  docsUrl: "https://api-docs.deepseek.com/",
  defaults: {
    baseUrl: "https://api.deepseek.com",
    endpoints: [WireKind.Chat],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    { key: "name", label: "Name", placeholder: "deepseek", required: true },
    { key: "apiKeys", label: "API key", placeholder: "sk-…", required: true },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
