// Anthropic thinking-signature normalization (request hook).
//
// Runs on the final Anthropic Messages body — after any format conversion,
// for every path (native /v1/messages, chat->messages, the web-tool loop) —
// same placement as the other hooks in this stack.
//
// A `thinking` content block is REQUIRED to carry a `signature` (Anthropic's
// cryptographic proof the block came from a genuine extended-thinking turn);
// Anthropic verifies it when a client echoes the block back on a later turn
// and 400s if it's missing or invalid. The gateway can never guarantee a
// signature it's forwarding is valid for the upstream a request is ABOUT to
// hit, for two independent reasons:
//
//   1. Synthetic blocks. Several gateway paths synthesize a `thinking` block
//      from a non-Anthropic reasoning source (inline <thinking> tag
//      extraction, or bridging Chat/Responses `reasoning_content` into
//      Anthropic shape — see wire/anthropic.ts's SYNTHETIC_THINKING_SIGNATURE).
//      Those carry a placeholder signature that was never real.
//   2. Genuine blocks, wrong destination. Even a REAL Anthropic signature
//      (from an actual extended-thinking turn) is scoped to the account/key
//      that produced it. A model's fallback chain can route the SAME
//      conversation to a different Anthropic-compatible provider on retry —
//      the signature from provider A is not guaranteed valid against
//      provider B, even though both speak native Messages.
//
// So every thinking block — synthetic or genuine — that reaches this hook
// gets normalized: converted back to a plain, signature-free `text` block
// carrying the SAME reasoning prose (thinkingBlocksToText), so the model
// keeps its prior reasoning as context across an account/provider switch
// instead of silently losing it. `redacted_thinking` blocks (Anthropic's
// encrypted-reasoning form) are always dropped — there is no readable text
// to preserve.
//
// This is the NON-LOSSY choice: the alternative (stripThinkingBlocks, also
// exported below for callers that want it) drops the reasoning outright.
// Converting to text keeps the model's chain-of-thought as ordinary
// conversation content — invisible to Anthropic's thinking-specific
// validation (a text block has no signature requirement) but still present
// for the model to read.

import type { Json } from "../../pipeline";

/**
 * Drop every `thinking`/`redacted_thinking` block outright — the lossy
 * option. Exported for callers that explicitly want reasoning discarded
 * rather than preserved as text; NOT used by the default request-hook stack
 * (see thinkingBlocksToText).
 */
export function stripThinkingBlocks(
  requestBody: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return mapThinkingBlocks(requestBody, () => undefined);
}

/**
 * Rewrite `thinking` blocks to signature-free `text` blocks, preserving the
 * reasoning prose so the model keeps its prior context across an account
 * switch. A `thinking` field that is empty or whitespace-only — the default
 * when the producing model used `display:"omitted"` (Opus 4.8/4.7, Sonnet 5,
 * Fable 5) — has no prose to carry, and `{type:"text", text:""}` is rejected
 * by the API (text must be non-empty), so such a block is dropped instead.
 * `redacted_thinking` blocks are always dropped (encrypted, no readable text).
 */
export function thinkingBlocksToText(
  requestBody: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return mapThinkingBlocks(requestBody, (block) => {
    const raw = block["thinking"];
    const text = typeof raw === "string" ? raw : "";
    if (text.trim() === "") return undefined; // empty → drop, not an empty text block
    return { type: "text", text };
  });
}

/**
 * Walk `messages[].content`, replacing each `thinking` block with the result of
 * `transform` (return `undefined` to drop it) and always dropping
 * `redacted_thinking` blocks. All other blocks pass through untouched. Returns
 * a shallow copy; only messages whose content actually changed are rebuilt.
 */
function mapThinkingBlocks(
  requestBody: Readonly<Record<string, unknown>>,
  transform: (block: Record<string, unknown>) => unknown,
): Record<string, unknown> {
  const messages = requestBody["messages"];
  if (!Array.isArray(messages)) return { ...requestBody };

  let changed = false;
  const newMessages = messages.map((m) => {
    if (!m || typeof m !== "object" || Array.isArray(m)) return m;
    const msg = m as Record<string, unknown>;
    const content = msg["content"];
    if (!Array.isArray(content)) return msg;

    let blockChanged = false;
    const newContent: unknown[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && !Array.isArray(block)) {
        const b = block as Record<string, unknown>;
        const type = b["type"];
        if (type === "thinking") {
          const replacement = transform(b);
          if (replacement !== undefined) newContent.push(replacement);
          blockChanged = true;
          continue;
        }
        if (type === "redacted_thinking") {
          blockChanged = true; // encrypted; nothing to preserve
          continue;
        }
      }
      newContent.push(block);
    }

    if (!blockChanged) return msg;
    changed = true;
    return { ...msg, content: newContent };
  });

  if (!changed) return { ...requestBody };
  return { ...requestBody, messages: newMessages };
}

// Re-typed entry point for the request-hook stack (Json in/out, matching
// normalizeThinkingConfig/clampMaxTokens's own signatures).
export function normalizeThinkingSignatures(body: Json): Json {
  return thinkingBlocksToText(body) as Json;
}
