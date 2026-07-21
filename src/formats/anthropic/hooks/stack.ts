// The Anthropic request-hook stack.
//
// Composes the Anthropic-native request hooks into an ordered RequestTransform[]
// that the Anthropic provider adapter returns from requestTransforms(). Because
// the engine runs adapter request transforms on the FINAL upstream body inside
// attemptOnce (after any format conversion), these fire identically for:
//   - native  /v1/messages           (messages -> messages, no convert)
//   - converted /v1/chat/completions  (chat -> messages)
//   - the web-tool loop               (runOneTurnAttempt uses the same route)
//
// Order matters:
//   1. thinking-signature — normalize/strip thinking-block signatures (structural
//                          body-shape fix; runs first so every hook after this
//                          sees a body with no `thinking`-typed content blocks)
//   2. max-tokens       — clamp to the hop ceiling, re-reconcile budget
//   3. prefill          — append a trailing user turn if the convo ends assistant
//   4. sanitize-request — rescue effort from non-standard fields into
//                          output_config.effort, then strip every top-level
//                          field not in the Anthropic allowlist
//   5. thinking-mode    — per-model thinking type normalization (adaptive ↔
//                          enabled, forced adaptive for Fable/Mythos, etc.)
//   6. thinking-config  — normalize thinking + hoist system; may raise
//                          max_tokens (gets the final say on the ceiling);
//                          strips output_config.effort on Haiku
//
// The four-breakpoint cache_control ceiling is enforced later by the Anthropic
// adapter builder, after family/adapter/model transforms have all run.
//
// Each stage is individually guarded by applyBodyTransforms in the engine (a
// throw is caught and the body passes through), so one bad hook can't break the
// proxy path. Every stage is also a no-op when its trigger condition is absent.

import {
  onRequest,
  onResponse,
  type TaggedRequestTransform,
  type TaggedResponseTransform,
  type TransformCtx,
} from "../../pipeline";
import { normalizeThinkingSignatures } from "./thinking-signature";
import { normalizeThinkingConfig } from "./thinking-config";
import { clampMaxTokens } from "./max-tokens";
import { applyPrefillFix } from "../prefill";
import { sanitizeAnthropicRequest } from "./sanitize-request";
import { sanitizeAnthropicResponse } from "./sanitize-response";
import { normalizeThinkingMode } from "./thinking-mode";

// Resolve the upstream model id a hook should key on. Prefer the chain-hop's
// upstream model; fall back to whatever is on the body.
function modelOf(body: { model?: unknown }, ctx: TransformCtx): string {
  if (typeof ctx.upstreamModel === "string" && ctx.upstreamModel)
    return ctx.upstreamModel;
  return typeof body.model === "string" ? body.model : "";
}

// The Anthropic-native request hooks, as format-tagged ("messages") transforms.
//
// These are an ALL-PROVIDER request default: the engine adds them to every
// route, and buildTransformPlan places a "messages"-tagged request stage where
// the body is in Messages shape. To exactly reproduce the historical behavior
// (they fired only when the PROVIDER emitted Messages — `requestHooksForFmt`
// keyed on providerFmt), each hook is additionally gated on
// `ctx.providerFmt === "messages"`, so the pre-conversion case (a client sending
// Messages to a non-Messages provider) stays a no-op. Placed post-conversion for
// a messages provider, i.e. on the freshly-converted Anthropic body, exactly as
// before. Ordering among them matters (see below); every stage is self-guarded
// and a no-op when its trigger is absent.
//
//   1. thinking-signature — normalize/strip thinking-block signatures
//   2. max-tokens       — clamp to the hop ceiling, re-reconcile budget
//   3. prefill          — append a trailing user turn if the convo ends assistant
//   4. sanitize-request — rescue effort, strip non-Anthropic fields
//   5. thinking-mode    — per-model thinking type normalization
//   6. thinking-config  — normalize thinking + hoist system, may raise max_tokens
// Cache-control limiting occurs later at the final Anthropic adapter boundary.
function messagesOnly(ctx: TransformCtx): boolean {
  return ctx.providerFmt === "messages";
}

// Shared `group` for all six hooks below — see TransformMeta's doc comment
// in formats/pipeline.ts: siblings with the same `group` collapse into one
// row in the resolved-transforms UI instead of showing as six. These hooks
// always run together, in this fixed order, on every Messages-shaped hop, so
// they read as one conceptual unit ("Anthropic request normalization") to an
// operator, even though each is independently guarded and individually named
// for the debug trace log.
const GROUP = "anthropic-hooks";

export function defaultAnthropicRequestHooks(): TaggedRequestTransform[] {
  return [
    // 1. Runs FIRST: every `thinking` content block the request carries —
    // real or gateway-synthesized — gets normalized to a signature-free
    // `text` block before anything else inspects the body.
    onRequest(
      "messages",
      "anthropic:thinking-signature",
      (body, ctx) =>
        messagesOnly(ctx) ? normalizeThinkingSignatures(body) : body,
      {
        label: "Thinking-signature normalization",
        blurb:
          "Rewrites every thinking block to signature-free text before anything else inspects the body — a fallback-chain retry can route the same conversation to a different Anthropic-compatible provider that can't validate another provider's signature.",
        group: GROUP,
      },
    ),
    // 2. Clamp max_tokens to the hop ceiling. Runs before thinking-config
    // so thinking-config gets the final say (it may raise max_tokens to
    // accommodate budget_tokens).
    onRequest(
      "messages",
      "anthropic:max-tokens",
      (body, ctx) =>
        messagesOnly(ctx) ? clampMaxTokens(body, ctx.maxOutputTokens) : body,
      {
        label: "Max-tokens ceiling clamp",
        blurb:
          "Clamps max_tokens to the hop's effective ceiling, re-reconciling the thinking budget if the clamp would breach budget < max.",
        group: GROUP,
      },
    ),
    // 3. Prefill fix — structural, no interaction with the fields below.
    onRequest(
      "messages",
      "anthropic:prefill",
      (body, ctx) => {
        if (messagesOnly(ctx)) applyPrefillFix(body, modelOf(body, ctx));
        return body;
      },
      {
        label: "Trailing-turn prefill fix",
        blurb:
          "Appends a trailing user turn (with tool_result blocks if needed) when the conversation ends on assistant — a Claude 4.6+ prefill requirement.",
        group: GROUP,
      },
    ),
    // 4. Rescue effort hints from non-standard fields (reasoning.effort,
    // reasoning_effort) into output_config.effort, then strip every
    // top-level field the Anthropic API does not accept. Runs before
    // thinking-config so the rescued effort is visible when thinking-config
    // strips output_config.effort on Haiku.
    onRequest(
      "messages",
      "anthropic:sanitize-request",
      (body, ctx) =>
        messagesOnly(ctx)
          ? sanitizeAnthropicRequest(body, modelOf(body, ctx))
          : body,
      {
        label: "Unsupported-field sanitization",
        blurb:
          "Rescues effort from non-standard fields into output_config.effort, then strips every top-level field the Anthropic Messages API does not accept.",
        group: GROUP,
      },
    ),
    // 5. Per-model thinking type normalization — converts the thinking
    // config into a shape the target model accepts (e.g. enabled→adaptive
    // for Opus 4.7+/Sonnet 5+, adaptive→enabled for ≤4.5/Haiku, forced
    // adaptive for Fable/Mythos). Runs before thinking-config so budget
    // reconciliation sees the final thinking type.
    onRequest(
      "messages",
      "anthropic:thinking-mode",
      (body, ctx) =>
        messagesOnly(ctx)
          ? normalizeThinkingMode(body, modelOf(body, ctx))
          : body,
      {
        label: "Thinking-mode normalization",
        blurb:
          "Transforms the thinking config into the shape the target model supports — e.g. enabled→adaptive for Opus 4.7+, adaptive→enabled for older models.",
        group: GROUP,
      },
    ),
    // 6. Runs LAST: normalize thinking config (adaptive→enabled on Haiku,
    // budget_tokens floor), hoist system turns, and reconcile budget vs
    // max_tokens. Gets the final say on max_tokens — may raise it above
    // the ceiling max-tokens imposed if budget demands it. Also strips
    // output_config.effort on Haiku (which rejects it).
    onRequest(
      "messages",
      "anthropic:thinking-config",
      (body, ctx) =>
        messagesOnly(ctx)
          ? normalizeThinkingConfig(body, modelOf(body, ctx))
          : body,
      {
        label: "Thinking-config normalization",
        blurb:
          "Normalizes the thinking config (adaptive→enabled on Haiku, budget_tokens floor) and hoists mid-conversation system turns; may raise max_tokens.",
        group: GROUP,
      },
    ),
  ];
}

// Response sanitization — ensures every response returned to a Messages client
// contains only valid Anthropic Messages API fields. Tagged "messages" so it
// runs post-bridge (when clientFmt is messages). Gated on clientFmt to be a
// no-op when the client is chat/responses.
export function defaultAnthropicResponseHooks(): TaggedResponseTransform[] {
  return [
    onResponse(
      "messages",
      "anthropic:sanitize-response",
      (body, ctx) =>
        ctx.clientFmt === "messages" ? sanitizeAnthropicResponse(body) : body,
      {
        label: "Response field sanitization",
        blurb:
          "Strips non-Anthropic fields from the response, normalizes stop_reason, and ensures the response shape matches the Messages API spec.",
        group: GROUP,
      },
    ),
  ];
}
