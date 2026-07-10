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

import type { Json } from "../../pipeline";

// Anthropic rejects adaptive thinking + output_config.effort on Haiku.
const ADAPTIVE_UNSUPPORTED = /haiku/i;
const MIN_BUDGET = 1024;
const HAIKU_ENABLED_BUDGET = 10000;

interface ThinkingConfig {
  type?: string;
  budget_tokens?: number;
  [k: string]: unknown;
}

// Normalize the thinking config on an Anthropic Messages body. `model` is the
// upstream model id (so the Haiku check keys on what actually gets called).
// Mutates and returns the body.
export function normalizeThinkingConfig(body: Json, model: string): Json {
  if (!body || typeof body !== "object") return body;

  // 1. Hoist mid-conversation system turns into the top-level system field.
  hoistSystemMessages(body);

  const thinking = body.thinking as ThinkingConfig | undefined;
  if (!thinking || typeof thinking !== "object") return body;

  // 2. Downgrade adaptive thinking on models that don't support it (Haiku).
  if (thinking.type === "adaptive" && ADAPTIVE_UNSUPPORTED.test(model)) {
    body.thinking = { type: "enabled", budget_tokens: HAIKU_ENABLED_BUDGET };
    // Also strip an output_config.effort the same models reject.
    stripHaikuEffort(body);
  }

  // 3. Reconcile budget_tokens against max_tokens (Anthropic requires
  //    max_tokens > budget_tokens, and budget_tokens >= 1024).
  const t = body.thinking as ThinkingConfig;
  if (t && t.type === "enabled" && typeof t.budget_tokens === "number") {
    if (t.budget_tokens < MIN_BUDGET) t.budget_tokens = MIN_BUDGET;
    const maxTokens =
      typeof body.max_tokens === "number" ? body.max_tokens : undefined;
    if (maxTokens !== undefined && t.budget_tokens >= maxTokens) {
      // Prefer raising max_tokens to keep the requested thinking depth.
      body.max_tokens = t.budget_tokens + MIN_BUDGET;
    }
  }

  return body;
}

// Move any `role:"system"` message content into the top-level `system` field
// (as text blocks appended after existing system content), preserving order.
function hoistSystemMessages(body: Json): void {
  const messages = body.messages;
  if (!Array.isArray(messages)) return;
  const systemTexts: string[] = [];
  const kept: unknown[] = [];
  for (const mRaw of messages) {
    const m = mRaw as { role?: string; content?: unknown } | null;
    if (m && m.role === "system") {
      const text = messageText(m.content);
      if (text.trim()) systemTexts.push(text);
      continue; // drop from messages[]
    }
    kept.push(mRaw);
  }
  if (systemTexts.length === 0) return;

  const existing = body.system;
  const existingBlocks: Array<Record<string, unknown>> = Array.isArray(existing)
    ? (existing as Array<Record<string, unknown>>)
    : typeof existing === "string" && existing.trim()
      ? [{ type: "text", text: existing }]
      : [];
  const newBlocks = systemTexts.map((text) => ({ type: "text", text }));
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
function stripHaikuEffort(body: Json): void {
  const oc = body.output_config as Record<string, unknown> | undefined;
  if (oc && typeof oc === "object" && oc.effort != null) {
    delete oc.effort;
    if (Object.keys(oc).length === 0) delete body.output_config;
  }
}
