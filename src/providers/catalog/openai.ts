import { OpenAICompatibleAdapter } from "../base";
import { WireKind } from "../../types";

// OpenAI official API. Bearer auth, chat + responses endpoints.
//
// Subclass of OpenAICompatibleAdapter that adds a model-aware endpoint
// preference: OpenAI's newer model families (GPT-5, Codex, GPT Image 2, and
// future reasoning/multimodal models) are Responses-API-first — some Codex
// models don't support Chat Completions at all — while older/dual models
// (GPT-4.1, GPT-4o, o1) work on either. When this provider accepts the responses
// endpoint, we prefer it for those newer models; everything else falls through to
// chat (the universally supported default). A per-link endpoint pin still wins.
class OpenAIAdapter extends OpenAICompatibleAdapter {
  preferredEndpoint(model: string, accepted: WireKind[]): WireKind | undefined {
    if (accepted.includes(WireKind.Responses) && prefersResponses(model))
      return WireKind.Responses;
    return undefined;
  }
}

// True for OpenAI model ids that are Responses-API-first. Forward-looking and
// deliberately loose (matches families, not a frozen id list) so newly released
// GPT-5+/Codex/Image models are covered without edits:
//   - gpt-5 and up (gpt-5.5, gpt-5.4-mini, gpt-6-*, …)
//   - any "codex" model (often Responses-only)
//   - gpt-image-2 and up
//   - the o-series reasoning models from o3 up (o3/o4/… lead with Responses)
// Older dual-endpoint models (gpt-4.1, gpt-4o, o1) return false → chat default.
export function prefersResponses(model: string): boolean {
  const m = model.toLowerCase();
  if (m.includes("codex")) return true;
  const gpt = m.match(/^gpt-(\d+)/);
  if (gpt && Number(gpt[1]) >= 5) return true;
  const gptImage = m.match(/^gpt-image-(\d+)/);
  if (gptImage && Number(gptImage[1]) >= 2) return true;
  const oSeries = m.match(/^o(\d+)/);
  if (oSeries && Number(oSeries[1]) >= 3) return true;
  return false;
}

export const openai = new OpenAIAdapter({
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
