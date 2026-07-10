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
//   2. thinking-config  — normalize thinking + hoist system, may raise max_tokens
//   3. max-tokens       — clamp to the hop ceiling, re-reconcile budget
//   4. prefill          — append a trailing user turn if the convo ends assistant
//
// Each stage is individually guarded by applyBodyTransforms in the engine (a
// throw is caught and the body passes through), so one bad hook can't break the
// proxy path. Every stage is also a no-op when its trigger condition is absent.

import {
  onRequest,
  type TaggedRequestTransform,
  type TransformCtx,
  type AnthropicMessagesRequest,
} from "../../pipeline";
import { normalizeThinkingSignatures } from "./thinking-signature";
import { normalizeThinkingConfig } from "./thinking-config";
import { clampMaxTokens } from "./max-tokens";
import { applyPrefillFix } from "../prefill";

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
//   2. thinking-config  — normalize thinking + hoist system, may raise max_tokens
//   3. max-tokens       — clamp to the hop ceiling, re-reconcile budget
//   4. prefill          — append a trailing user turn if the convo ends assistant
function messagesOnly(ctx: TransformCtx): boolean {
  return ctx.providerFmt === "messages";
}

// Shared `group` for all four hooks below — see TransformMeta's doc comment
// in formats/pipeline.ts: siblings with the same `group` collapse into one
// row in the resolved-transforms UI instead of showing as four. These four
// always run together, in this fixed order, on every Messages-shaped hop, so
// they read as one conceptual unit ("Anthropic request normalization") to an
// operator, even though each is independently guarded and individually named
// for the debug trace log.
const GROUP = "anthropic-hooks";

export function defaultAnthropicRequestHooks(): TaggedRequestTransform[] {
  return [
    // Runs FIRST: every `thinking` content block the request carries — real
    // or gateway-synthesized — gets normalized to a signature-free `text`
    // block before anything else inspects the body. See
    // thinking-signature.ts's module doc for why this can't be skipped for
    // "genuine" Anthropic thinking blocks either (a fallback-chain retry can
    // route the same conversation to a different Anthropic-compatible
    // provider, which can't validate another provider's signature).
    onRequest(
      "messages",
      "anthropic:thinking-signature",
      (body, ctx) =>
        messagesOnly(ctx)
          ? (normalizeThinkingSignatures(
              body as Record<string, unknown>,
            ) as AnthropicMessagesRequest)
          : body,
      {
        label: "Thinking-signature normalization",
        blurb:
          "Rewrites every thinking block to signature-free text before anything else inspects the body — a fallback-chain retry can route the same conversation to a different Anthropic-compatible provider that can't validate another provider's signature.",
        group: GROUP,
      },
    ),
    onRequest(
      "messages",
      "anthropic:thinking-config",
      (body, ctx) =>
        messagesOnly(ctx)
          ? (normalizeThinkingConfig(
              body as Record<string, unknown>,
              modelOf(body, ctx),
            ) as AnthropicMessagesRequest)
          : body,
      {
        label: "Thinking-config normalization",
        blurb:
          "Normalizes the thinking config (adaptive→enabled on Haiku, budget_tokens floor) and hoists mid-conversation system turns; may raise max_tokens.",
        group: GROUP,
      },
    ),
    onRequest(
      "messages",
      "anthropic:max-tokens",
      (body, ctx) =>
        messagesOnly(ctx)
          ? (clampMaxTokens(
              body as Record<string, unknown>,
              ctx.maxOutputTokens,
            ) as AnthropicMessagesRequest)
          : body,
      {
        label: "Max-tokens ceiling clamp",
        blurb:
          "Clamps max_tokens to the hop's effective ceiling, re-reconciling the thinking budget if the clamp would breach budget < max.",
        group: GROUP,
      },
    ),
    onRequest(
      "messages",
      "anthropic:prefill",
      (body, ctx) => {
        if (messagesOnly(ctx))
          applyPrefillFix(body as Record<string, unknown>, modelOf(body, ctx));
        return body;
      },
      {
        label: "Trailing-turn prefill fix",
        blurb:
          "Appends a trailing user turn (with tool_result blocks if needed) when the conversation ends on assistant — a Claude 4.6+ prefill requirement.",
        group: GROUP,
      },
    ),
  ];
}
