// Default (all-provider) transform registry.
//
// The gateway applies a few transform layers to EVERY route, regardless of
// provider: thinking extraction and the Anthropic request hooks today (web-tool
// definition rewriting is applied by the web-tool loop through this same seam).
// Rather than hand-wire each one inline in the engine, they are declared here as
// a registry of DefaultTransformSet entries. `collectDefaults(ctx)` flattens the
// registry into the request/response/stream bags the engine hands to
// buildTransformPlan. Adding a new all-provider behavior = add one entry.
//
// Every default returns FORMAT-TAGGED transforms (onRequest/onResponse/
// onStreamEvent), so buildTransformPlan places each stage automatically relative
// to the wire conversion — no per-set placement logic here or in the engine.

import type {
  AnyRequestTransform,
  AnyResponseTransform,
  AnyStreamTransform,
  WireFmt,
} from "../pipeline";
import type { ThinkingConverter } from "../thinking";
import { defaultThinkingResponse, defaultThinkingStream } from "../thinking";
import {
  defaultAnthropicRequestHooks,
  defaultAnthropicResponseHooks,
} from "../anthropic/hooks/stack";
import { onRequest, onResponse } from "../pipeline";
import { sanitizeChatResponse } from "../hooks/sanitize-chat-response";
import { sanitizeResponsesResponse } from "../hooks/sanitize-responses-response";
import { normalizeOpenAIReasoning } from "../hooks/openai-reasoning";

// What a default set may need to build its (per-route) stages. Kept minimal;
// grows only when a new default genuinely needs more route context.
export interface DefaultCtx {
  /** Shared thinking converter (stateless) used by the thinking default. */
  thinking: ThinkingConverter;
  /** The hop's provider wire format — thinking runs once, on the provider shape. */
  providerFmt: WireFmt;
}

// One registered all-provider default layer. Each hook is optional and returns
// the tagged stages for that phase; omitted phases contribute nothing.
export interface DefaultTransformSet {
  id: string;
  request?(ctx: DefaultCtx): AnyRequestTransform[];
  response?(ctx: DefaultCtx): AnyResponseTransform[];
  stream?(ctx: DefaultCtx): AnyStreamTransform[];
}

// The registry — the single source of truth for always-on transforms. Order is
// the order stages are collected into each bag (buildTransformPlan then places
// them by tag, so this order only matters among same-format stages).
export const DEFAULT_TRANSFORMS: DefaultTransformSet[] = [
  {
    // Anthropic-native request hooks (thinking-config, max_tokens, prefill),
    // tagged "messages" + gated on providerFmt so they engage only for a hop
    // that emits Messages — native Anthropic OR a Claude model behind an
    // OpenAI-type provider whose hop routes /v1/messages.
    id: "anthropic-hooks",
    request: () => defaultAnthropicRequestHooks(),
    response: () => defaultAnthropicResponseHooks(),
  },
  {
    // OpenAI-compatible request hooks: normalize reasoning effort to the
    // valid OpenAI set (low | medium | high) and default reasoning.summary
    // to "detailed" when effort is present. Tagged "chat" and "responses",
    // gated on providerFmt so they only fire for OpenAI-compatible hops.
    id: "openai-hooks",
    request: () => [
      onRequest(
        "chat",
        "openai:reasoning",
        (body, ctx) =>
          ctx.providerFmt === "chat"
            ? normalizeOpenAIReasoning(body, {
                catalogId: ctx.provider.catalogId,
              })
            : body,
        {
          label: "Reasoning normalization",
          blurb:
            "Normalizes reasoning_effort for OpenAI-compatible providers; Z.AI GLM-5.2+ keeps its native effort levels and synchronizes the thinking toggle.",
          group: "openai-hooks",
        },
      ),
      onRequest(
        "responses",
        "openai:reasoning-responses",
        (body, ctx) =>
          ctx.providerFmt === "responses"
            ? normalizeOpenAIReasoning(body, {
                catalogId: ctx.provider.catalogId,
              })
            : body,
        {
          label: "Reasoning normalization (Responses)",
          blurb:
            "Normalizes reasoning.effort to valid OpenAI values and defaults reasoning.summary to detailed.",
          group: "openai-hooks",
        },
      ),
    ],
  },
  {
    id: "response-sanitize",
    response: () => [
      onResponse(
        "chat",
        "chat:sanitize-response",
        (body, ctx) =>
          ctx.clientFmt === "chat" ? sanitizeChatResponse(body) : body,
        {
          label: "Chat response sanitization",
          blurb:
            "Normalizes finish_reason to valid OpenAI values (stop, length, tool_calls, content_filter).",
        },
      ),
      onResponse(
        "responses",
        "responses:sanitize-response",
        (body, ctx) =>
          ctx.clientFmt === "responses"
            ? sanitizeResponsesResponse(body)
            : body,
        {
          label: "Responses response sanitization",
          blurb:
            "Normalizes status to valid Responses API values (completed, incomplete, failed).",
        },
      ),
    ],
  },
  {
    // <thinking>/<reasoning> extraction. Runs ONCE, on the provider-native shape,
    // pre-bridge (exactly as the old standalone applyThinking/thinkingStream did)
    // — so we emit only the transform tagged this hop's providerFmt, not all
    // three (a clientFmt-tagged copy would run a wasteful post-bridge second pass).
    id: "thinking",
    response: (ctx) =>
      defaultThinkingResponse(ctx.thinking).filter(
        (t) => t.format === ctx.providerFmt,
      ),
    stream: (ctx) =>
      defaultThinkingStream().filter((t) => t.format === ctx.providerFmt),
  },
];

// Flatten the registry into the three bags the engine merges with adapter +
// model transforms before calling buildTransformPlan.
export function collectDefaults(ctx: DefaultCtx): {
  request: AnyRequestTransform[];
  response: AnyResponseTransform[];
  stream: AnyStreamTransform[];
} {
  const request: AnyRequestTransform[] = [];
  const response: AnyResponseTransform[] = [];
  const stream: AnyStreamTransform[] = [];
  for (const set of DEFAULT_TRANSFORMS) {
    if (set.request) request.push(...set.request(ctx));
    if (set.response) response.push(...set.response(ctx));
    if (set.stream) stream.push(...set.stream(ctx));
  }
  return { request, response, stream };
}
