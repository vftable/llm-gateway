// Anthropic thinking-config normalization (request hook).
//
// Runs on the final Anthropic Messages body — after any format conversion, for
// every path (native /v1/messages, chat->messages, the web-tool loop). It makes
// a request whose thinking config a client sent (or a converter produced) valid
// against the live Anthropic Messages spec, so the upstream doesn't 400:
//
//   - `thinking.type: "adaptive"` is unsupported on Haiku -> downgrade to
//     { type: "enabled", budget_tokens: 10000 }.
//   - `budget_tokens` must be >= 1024 and STRICTLY LESS THAN max_tokens (it
//     counts toward max_tokens). Reconcile: prefer raising max_tokens to
//     budget+1024; if that isn't possible (no ceiling headroom) shrink the
//     budget so some tokens remain for the answer.
//   - Mid-conversation `role:"system"` messages are hoisted into the top-level
//     `system` field (Anthropic has no system role inside messages[]).
//
// Ported from 9router formats/claude.js (normalizeClaudePassthrough +
// prepareClaudeRequest), STRUCTURAL rules only — no OAuth/cloaking/attestation.
//
// Verified against https://platform.claude.com/docs/en/api/messages:
//   thinking = { type:"enabled", budget_tokens } | { type:"disabled" }
//            | { type:"adaptive" };  budget_tokens >= 1024 and < max_tokens.

import type {
  AnthropicMessagesRequest,
  AnthropicMessage,
  AnthropicTextBlock,
  AnthropicThinkingConfig,
} from "../../pipeline";
import { ADAPTIVE_UNSUPPORTED_RE as ADAPTIVE_UNSUPPORTED } from "../model-version";
const MIN_BUDGET = 1024;
const HAIKU_ENABLED_BUDGET = 10000;

// Normalize the thinking config on an Anthropic Messages body. `model` is the
// upstream model id (so the Haiku check keys on what actually gets called).
// Mutates and returns the body.
export function normalizeThinkingConfig(
  body: AnthropicMessagesRequest,
  model: string,
): AnthropicMessagesRequest {
  if (!body || typeof body !== "object") return body;

  // 1. Hoist mid-conversation system turns into the top-level system field.
  hoistSystemMessages(body);

  const thinking = body.thinking;
  if (!thinking || typeof thinking !== "object") return body;

  // 2. Downgrade adaptive thinking on models that don't support it (Haiku).
  if (thinking.type === "adaptive" && ADAPTIVE_UNSUPPORTED.test(model)) {
    body.thinking = { type: "enabled", budget_tokens: HAIKU_ENABLED_BUDGET };
    // Also strip an output_config.effort the same models reject.
    stripHaikuEffort(body);
  }

  // 3. Reconcile budget_tokens against max_tokens (Anthropic requires
  //    max_tokens > budget_tokens, and budget_tokens >= 1024).
  const t = body.thinking as AnthropicThinkingConfig;
  if (t && t.type === "enabled" && typeof t.budget_tokens === "number") {
    if (t.budget_tokens < MIN_BUDGET) t.budget_tokens = MIN_BUDGET;
    const maxTokens =
      typeof body.max_tokens === "number" ? body.max_tokens : undefined;
    if (maxTokens !== undefined && t.budget_tokens >= maxTokens) {
      body.max_tokens = t.budget_tokens + MIN_BUDGET;
    }
  }

  return body;
}

// Move any `role:"system"` message content into the top-level `system` field
// (as text blocks appended after existing system content), preserving order.
function hoistSystemMessages(body: AnthropicMessagesRequest): void {
  const messages = body.messages;
  if (!Array.isArray(messages)) return;
  const systemTexts: string[] = [];
  const kept: AnthropicMessage[] = [];
  for (const mRaw of messages) {
    if (mRaw && mRaw.role === "system") {
      const text = messageText(mRaw.content);
      if (text.trim()) systemTexts.push(text);
      continue;
    }
    kept.push(mRaw);
  }
  if (systemTexts.length === 0) return;

  const existing = body.system;
  const existingBlocks: AnthropicTextBlock[] = Array.isArray(existing)
    ? (existing as AnthropicTextBlock[])
    : typeof existing === "string" && existing.trim()
      ? [{ type: "text" as const, text: existing }]
      : [];
  const newBlocks: AnthropicTextBlock[] = systemTexts.map((text) => ({
    type: "text" as const,
    text,
  }));
  body.system = [...existingBlocks, ...newBlocks];
  body.messages = kept;
}

// Extract plain text from a message content (string or block array).
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (typeof b === "string") parts.push(b);
    else if (b && typeof b === "object") {
      const t = (b as { text?: unknown }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.join("\n");
}

// Strip output_config.effort (and an emptied output_config) — Haiku rejects it.
function stripHaikuEffort(body: AnthropicMessagesRequest): void {
  const oc = body.output_config;
  if (oc && typeof oc === "object" && oc.effort != null) {
    delete oc.effort;
    if (Object.keys(oc).length === 0) delete body.output_config;
  }
}
