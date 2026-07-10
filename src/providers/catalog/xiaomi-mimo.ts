import { OpenAICompatibleAdapter } from "../base";
import { WireKind } from "../../types";

// Xiaomi MiMo — OpenAI-compatible endpoint for the MiMo model family.
class XiaomiMimoAdapter extends OpenAICompatibleAdapter {}

export const xiaomiMimo = new XiaomiMimoAdapter({
  id: "xiaomi-mimo",
  label: "Xiaomi MiMo",
  blurb: "Xiaomi's MiMo models via an OpenAI-compatible endpoint.",
  brand: "mimo",
  docsUrl: "https://xiaomimimo.com/",
  defaults: {
    baseUrl: "https://api.mimo.xiaomi.com",
    endpoints: [WireKind.Chat],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    { key: "name", label: "Name", placeholder: "xiaomi-mimo", required: true },
    { key: "apiKeys", label: "API key", required: true },
    {
      key: "baseUrl",
      label: "Base URL",
      editable: true,
      hint: "Adjust to the region/endpoint issued with your key.",
    },
  ],
});
