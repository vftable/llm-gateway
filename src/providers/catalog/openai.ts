import { OpenAICompatibleAdapter, isGPT5Family } from "../base";
import type { BuildCtx, BuiltRequest } from "../base";
import { WireKind } from "../../types";
import type { TestModelCtx, TestModelResult } from "../base/types";
import type {
  ChatCompletionRequest,
  ResponsesRequest,
  ResponsesResponse,
} from "../../formats/wire";

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

  chatCompletions(ctx: BuildCtx): BuiltRequest {
    if (isGPT5Family(ctx.model)) {
      const body = ctx.body as ChatCompletionRequest;
      delete body.temperature;
      delete body.top_p;
      delete body.top_k;
    }
    return super.chatCompletions(ctx);
  }

  responses(ctx: BuildCtx): BuiltRequest {
    if (isGPT5Family(ctx.model)) {
      const body = ctx.body as ResponsesRequest;
      delete body.temperature;
      delete body.top_p;
    }
    return super.responses(ctx);
  }

  async testModel(ctx: TestModelCtx): Promise<TestModelResult> {
    if (prefersResponses(ctx.model)) {
      return this.probeEndpoint(ctx, WireKind.Responses, {
        body: {
          model: ctx.model,
          input: "Reply with exactly: hi",
          max_output_tokens: 16,
        },
        summarize: (json) => {
          const r = json as ResponsesResponse;
          const msg = r.output?.find((o) => o.type === "message");
          const part = (
            msg?.content as Array<{ type?: string; text?: string }> | undefined
          )?.find((c) => c.type === "output_text");
          return { reply: part?.text ?? null };
        },
      });
    }
    return super.testModel(ctx);
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
