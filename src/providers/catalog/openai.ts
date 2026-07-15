import { OpenAICompatibleAdapter, prefersResponses } from "../base";
import { WireKind } from "../../types";

export { prefersResponses };

export const openai = new OpenAICompatibleAdapter({
  id: "openai",
  label: "OpenAI",
  blurb: "Official OpenAI API — GPT models, chat & responses endpoints.",
  brand: "openai",
  docsUrl: "https://platform.openai.com/docs/api-reference",
  defaults: {
    baseUrl: "https://api.openai.com",
    endpoints: [WireKind.Chat, WireKind.Responses],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    { key: "name", label: "Name", placeholder: "openai", required: true },
    {
      key: "apiKeys",
      label: "API key",
      placeholder: "sk-…",
      required: true,
      hint: "One per line — rotated round-robin.",
    },
  ],
});
