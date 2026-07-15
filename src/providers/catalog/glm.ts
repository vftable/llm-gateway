import { BuildCtx, BuiltRequest, OpenAICompatibleAdapter } from "../base";
import { WireKind } from "../../types";

// Z.ai GLM Coding Plan — OpenAI-compatible, but the chat/models paths sit under
// a deep prefix (/api/coding/paas/v4), not /v1. The adapter composes
//   origin + basePath + suffix
// so the upstream URL builds as:
//   https://api.z.ai + /api/coding/paas/v4 + /chat/completions
//   => https://api.z.ai/api/coding/paas/v4/chat/completions
class GlmAdapter extends OpenAICompatibleAdapter {
  chatCompletions(ctx: BuildCtx): BuiltRequest {
    console.log("GLM chatCompletions", ctx);
    return { url: ctx.url, headers: ctx.headers, body: ctx.body };
  }
}

export const glm = new GlmAdapter({
  id: "glm-coding",
  label: "GLM Coding Plan (Z.ai)",
  blurb:
    "Z.ai GLM coding-plan models — OpenAI-compatible under /api/coding/paas/v4.",
  brand: "zai",
  docsUrl: "https://docs.z.ai/",
  defaults: {
    baseUrl: "https://api.z.ai",
    basePath: "/api/coding/paas/v4",
    modelsPath: "/models",
    endpoints: [WireKind.Chat],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    { key: "name", label: "Name", placeholder: "glm-coding", required: true },
    {
      key: "apiKeys",
      label: "API key",
      placeholder: "…",
      required: true,
      hint: "One per line — rotated round-robin.",
    },
    {
      key: "baseUrl",
      label: "Base URL",
      editable: true,
      hint: "Origin only — the /api/coding/paas/v4 prefix is added automatically.",
    },
  ],
});
