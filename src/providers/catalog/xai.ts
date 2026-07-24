import { OpenAICompatibleAdapter } from "../base";
import { WireKind } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

// xAI — Grok models, OpenAI-compatible chat endpoint (api.x.ai/v1/…, same
// origin+/v1 convention as openai.ts — no basePath needed).
class XaiAdapter extends OpenAICompatibleAdapter {}

export const xai = new XaiAdapter({
  id: "xai",
  label: "xAI",
  blurb: "Grok models from xAI — OpenAI-compatible.",
  brand: "xai",
  docsUrl: "https://docs.x.ai/",
  defaults: {
    baseUrl: "https://api.x.ai",
    endpoints: [WireKind.Chat],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    { key: "name", label: "Name", placeholder: "xai", required: true },
    { key: "apiKeys", label: "API key", placeholder: "xai-…", required: true },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
