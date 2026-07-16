import { OpenAICompatibleAdapter } from "../base";
import { WireKind } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

// OpenCode Zen — OpenAI-compatible gateway aimed at coding agents.
class OpenCodeAdapter extends OpenAICompatibleAdapter {}

export const opencode = new OpenCodeAdapter({
  id: "opencode",
  label: "OpenCode Zen",
  blurb: "Coding-focused model gateway — OpenAI-compatible chat endpoint.",
  brand: "opencode",
  docsUrl: "https://opencode.ai/docs/zen/",
  defaults: {
    baseUrl: "https://opencode.ai/zen",
    endpoints: [WireKind.Chat],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    { key: "name", label: "Name", placeholder: "opencode", required: true },
    {
      key: "apiKeys",
      label: "API key",
      required: true,
    },
    {
      key: "baseUrl",
      label: "Base URL",
      editable: true,
      hint: "Point at your OpenCode instance if self-hosting.",
    },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
