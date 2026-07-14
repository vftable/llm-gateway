// Per-model thinking-mode normalization (request hook).
//
// Transforms the `thinking` config into a shape the target model actually
// accepts.  Each model family has different support:
//
//   Model                  adaptive  enabled+budget  disabled  display default
//   ─────────────────────  ────────  ──────────────  ────────  ───────────────
//   Fable 5, Mythos 5     always on  → adaptive      NO       omitted
//   Mythos Preview         default    accepted        NO       omitted
//   Opus 4.8 / 4.7         opt-in     → adaptive      OK       omitted
//   Sonnet 5               default    → adaptive      OK       omitted
//   Opus 4.6 / Sonnet 4.6  opt-in     accepted(dep)   OK       summarized
//   Haiku                   NO        required         OK       summarized
//   ≤4.5 (Sonnet/Opus)     NO        required         OK       summarized
//
// Models whose display defaults to "omitted" get `display: "summarized"`
// injected so thinking content is always returned — unless the client
// explicitly set display already.
//
// Runs AFTER sanitize-request (effort is already rescued) and BEFORE
// thinking-config (which reconciles budget_tokens vs max_tokens).

import type { AnthropicMessagesRequest } from "../../pipeline";

// ── model family detection ──────────────────────────────────────────────
//
// Patterns are deliberately forward-looking: they match the family prefix
// so newly-released point versions are covered without edits.  The order
// of checks in `normalizeThinkingMode` matters — more specific patterns
// (fable/mythos) are tested before the catch-all "claude-*" branches.

const FABLE = /claude-fable/i;
const MYTHOS = /claude-mythos(?!.*preview)/i;
const MYTHOS_PREVIEW = /claude-mythos.*preview/i;

// Opus 4.7+ (but NOT 4.6): matches claude-opus-4-7, claude-opus-4-8, etc.
const OPUS_47_PLUS = /claude-opus-4-([7-9]|\d{2,})/i;
// Opus 4.6 specifically
const OPUS_46 = /claude-opus-4-6/i;

// Sonnet 5+ (major version): matches claude-sonnet-5, claude-sonnet-6, etc.
const SONNET_5_PLUS = /claude-sonnet-([5-9]|\d{2,})(?:-|$)/i;
// Sonnet 4.6 specifically
const SONNET_46 = /claude-sonnet-4-6/i;

const HAIKU = /claude-haiku/i;

const DEFAULT_ADAPTIVE_BUDGET = 10_000;

interface ThinkingConfig {
  type?: string;
  budget_tokens?: number;
  display?: string;
  [k: string]: unknown;
}

export function normalizeThinkingMode(
  body: AnthropicMessagesRequest,
  model: string,
): AnthropicMessagesRequest {
  if (!body || typeof body !== "object") return body;

  ensureThinkingWhenEffort(body);

  // Fable 5 / Mythos 5 — adaptive always on, disabled not supported.
  // Display defaults to "omitted" upstream.
  if (FABLE.test(model) || MYTHOS.test(model)) {
    forceAdaptive(body);
    defaultDisplay(body);
    return body;
  }

  // Mythos Preview — adaptive default, disabled not supported,
  // enabled+budget still accepted. Display defaults to "omitted".
  if (MYTHOS_PREVIEW.test(model)) {
    disabledToAdaptive(body);
    defaultDisplay(body);
    return body;
  }

  // Opus 4.7, 4.8+ — only adaptive works; enabled is rejected.
  // Display defaults to "omitted".
  if (OPUS_47_PLUS.test(model)) {
    enabledToAdaptive(body);
    defaultDisplay(body);
    return body;
  }

  // Sonnet 5+ — adaptive default, can be disabled, enabled is rejected.
  // Display defaults to "omitted".
  if (SONNET_5_PLUS.test(model)) {
    enabledToAdaptive(body);
    defaultDisplay(body);
    return body;
  }

  // Opus 4.6 / Sonnet 4.6 — both adaptive and enabled accepted (enabled
  // deprecated). Display defaults to "summarized" (no injection needed).
  if (OPUS_46.test(model) || SONNET_46.test(model)) {
    return body;
  }

  // Haiku / older models (≤4.5) — no adaptive support.
  // Display defaults to "summarized" (no injection needed).
  if (HAIKU.test(model)) {
    return adaptiveToEnabled(body);
  }

  // Any other Claude model (older sonnet/opus 4.5, 3.x, etc.)
  // or non-Claude models — downgrade adaptive to enabled.
  if (/claude/i.test(model)) {
    return adaptiveToEnabled(body);
  }

  return body;
}

// If output_config.effort is set but thinking is absent, inject adaptive
// thinking — effort without thinking is a no-op on the Anthropic API.
function ensureThinkingWhenEffort(body: AnthropicMessagesRequest): void {
  if (body.thinking && typeof body.thinking === "object") return;
  const oc = body.output_config;
  if (!oc || typeof oc !== "object" || oc.effort === undefined) return;
  body.thinking = { type: "adaptive" };
}

// Force adaptive — used for models where thinking is always on.
// Converts any thinking config to adaptive; strips budget_tokens.
function forceAdaptive(
  body: AnthropicMessagesRequest,
): AnthropicMessagesRequest {
  const t = body.thinking as ThinkingConfig | undefined;
  if (!t || typeof t !== "object") {
    body.thinking = { type: "adaptive" };
    return body;
  }
  if (t.type === "disabled") {
    t.type = "adaptive";
  }
  if (t.type === "enabled") {
    t.type = "adaptive";
    delete t.budget_tokens;
  }
  if (t.type !== "adaptive") {
    t.type = "adaptive";
  }
  return body;
}

// Convert disabled to adaptive — for models where disabled is not supported
// but enabled+budget is still accepted.
function disabledToAdaptive(
  body: AnthropicMessagesRequest,
): AnthropicMessagesRequest {
  const t = body.thinking as ThinkingConfig | undefined;
  if (!t || typeof t !== "object") return body;
  if (t.type === "disabled") {
    t.type = "adaptive";
  }
  return body;
}

// Convert enabled to adaptive — for models that reject enabled but accept
// adaptive. Preserves disabled (turning thinking off is valid on these models).
function enabledToAdaptive(
  body: AnthropicMessagesRequest,
): AnthropicMessagesRequest {
  const t = body.thinking as ThinkingConfig | undefined;
  if (!t || typeof t !== "object") return body;
  if (t.type === "enabled") {
    t.type = "adaptive";
    delete t.budget_tokens;
  }
  return body;
}

// Convert adaptive to enabled — for older models that don't support adaptive.
// Strips output_config.effort which these models also reject.
function adaptiveToEnabled(
  body: AnthropicMessagesRequest,
): AnthropicMessagesRequest {
  const t = body.thinking as ThinkingConfig | undefined;
  if (!t || typeof t !== "object") return body;
  if (t.type === "adaptive") {
    t.type = "enabled";
    if (typeof t.budget_tokens !== "number") {
      t.budget_tokens = DEFAULT_ADAPTIVE_BUDGET;
    }
  }
  stripEffort(body);
  return body;
}

// For models whose API defaults to display: "omitted", inject
// display: "summarized" so thinking content is always returned — unless
// the client explicitly set display already or thinking is disabled.
function defaultDisplay(body: AnthropicMessagesRequest): void {
  const t = body.thinking as ThinkingConfig | undefined;
  if (!t || typeof t !== "object") return;
  if (t.type === "disabled") return;
  if (t.display !== undefined) return;
  t.display = "summarized";
}

function stripEffort(body: AnthropicMessagesRequest): void {
  const oc = body.output_config;
  if (oc && typeof oc === "object" && oc.effort != null) {
    delete oc.effort;
    if (Object.keys(oc).length === 0) delete body.output_config;
  }
}
