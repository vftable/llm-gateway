import { OpenAICompatibleAdapter } from "../base";
import { WireKind } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

// Proxy / bridge instance (LiteLLM, 9router, one-api, …) that accepts EITHER
// wire format and converts internally. nativeConversion=true forwards the
// client's request unchanged; both endpoints advertised. authScheme "both"
// sends the key as Bearer and x-api-key so either upstream picks it up.
class ProxyAdapter extends OpenAICompatibleAdapter {}

export const proxy = new ProxyAdapter({
  id: "proxy",
  label: "Proxy / Bridge",
  blurb: "LiteLLM, 9router or similar that converts formats internally.",
  brand: "proxy",
  defaults: {
    endpoints: [WireKind.Chat, WireKind.Responses, WireKind.Messages],
    authScheme: "both",
    nativeConversion: true,
  },
  fields: [
    { key: "name", label: "Name", placeholder: "litellm", required: true },
    {
      key: "baseUrl",
      label: "Base URL",
      placeholder: "http://localhost:4000",
      required: true,
      editable: true,
    },
    { key: "apiKeys", label: "API key", hint: "Optional." },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
