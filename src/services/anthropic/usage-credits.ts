// Detection for the Claude Code "long-context usage credits" 429.
//
// Anthropic returns a 429 rate_limit_error when a Claude Code subscription key's
// plan lacks the usage credits to serve a LONG-CONTEXT request. It is NOT a
// normal rate limit and NOT a key fault — the key is healthy, its plan just
// can't take this particular request. The engine treats it as a per-key "skip"
// signal: rotate to another key (no health penalty, no cooldown, no error log),
// and only fail the provider over once EVERY key is credit-less. See forward()'s
// credit rotation + KeyHealthStore.markCreditProven.

/** The canonical message Anthropic returns for this condition. Exported for the
 *  reason strings + tests that reference the exact wording. */
export const LONG_CONTEXT_USAGE_CREDITS_MESSAGE =
  "Usage credits are required for long context requests.";

// Anthropic has shipped this signal under more than one phrasing ("Usage credits
// are required…" and the older "Extra usage is required…"), and may append/adjust
// trailing wording. Match the stable core of each by substring so a minor
// message tweak upstream doesn't silently disable the rotation.
const LONG_CONTEXT_CREDIT_SUBSTRINGS = [
  "Usage credits are required for long context",
  "Extra usage is required for long context",
];

// Detect the long-context credits 429. Gated to Claude Code (only its
// subscription billing path produces this signal) but NOT to any model — any
// model on a Claude Code key can hit its plan's long-context credit ceiling.
export function isClaudeCodeUsageCreditsError(input: {
  status: number;
  catalogId: string | null | undefined;
  upstreamModel: string;
  body: string;
}): boolean {
  if (input.status !== 429 || input.catalogId !== "claude-code") return false;

  try {
    const parsed = JSON.parse(input.body) as {
      error?: { type?: unknown; message?: unknown };
    };
    if (parsed.error?.type !== "rate_limit_error") return false;
    const message = parsed.error.message;
    return (
      typeof message === "string" &&
      LONG_CONTEXT_CREDIT_SUBSTRINGS.some((s) => message.includes(s))
    );
  } catch {
    return false;
  }
}
