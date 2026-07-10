// Anthropic max_tokens ceiling clamp (request hook).
//
// Anthropic requires `max_tokens`, and a request whose max_tokens exceeds the
// model's real output ceiling is wasteful (and some upstreams 400). We clamp to
// the hop's effective ceiling — which comes from OUR OWN config
// (link ?? imported-model ?? exposed-model), threaded in via
// TransformCtx.maxOutputTokens — not a hardcoded per-model table.
//
// Ordering note: this runs AFTER thinking-config, which may have raised
// max_tokens to (budget_tokens + 1024). If the ceiling would clamp below that,
// we keep max_tokens > budget_tokens by shrinking the budget instead, so the
// request stays valid (Anthropic requires max_tokens strictly greater).

import type { Json } from "../../pipeline";

const MIN_BUDGET = 1024;

interface ThinkingConfig {
  type?: string;
  budget_tokens?: number;
}

// Clamp body.max_tokens to `ceiling` (when set and positive), preserving the
// Anthropic invariant max_tokens > thinking.budget_tokens. Mutates + returns.
export function clampMaxTokens(
  body: Json,
  ceiling: number | null | undefined,
): Json {
  if (!body || typeof body !== "object") return body;
  if (typeof ceiling !== "number" || ceiling <= 0) return body;
  const cur = body.max_tokens;
  if (typeof cur !== "number" || cur <= ceiling) return body;

  body.max_tokens = ceiling;

  // If a thinking budget now meets/exceeds the clamped max, shrink it so the
  // model still has room to answer (Anthropic: budget_tokens < max_tokens).
  const t = body.thinking as ThinkingConfig | undefined;
  if (
    t &&
    t.type === "enabled" &&
    typeof t.budget_tokens === "number" &&
    t.budget_tokens >= ceiling
  ) {
    t.budget_tokens = Math.max(MIN_BUDGET, ceiling - MIN_BUDGET);
  }
  return body;
}
