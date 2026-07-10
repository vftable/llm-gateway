// Shared Claude version check. Matches Claude models strictly NEWER than 4.5 —
// i.e. "over 4.5":
//   - claude-{sonnet,opus,haiku}-4-<N>   where N is 6-9 or two+ digits (4.6+)
//   - claude-{sonnet,opus,haiku}-<N>     where N is 5-9 or two+ digits (5+)
//   - claude-fable / claude-mythos       (any version)
// and nothing else — older Claude (4.5, 3.x, ...) and non-Claude models
// (gpt-*, gemini-*, ollama, ...) never match. Case-insensitive.
//
// This is the ONE place that regex lives. Consumers:
//   - the prefill auto-fix (a trailing assistant turn needs a synthetic user
//     "continue" turn on post-4.5 models) — see prefill.ts (modelNeedsPrefillFix).

const POST_45_RE =
  /claude-(?:sonnet|opus|haiku)-4-([6-9]|\d{2,})(?:-|$)|claude-(?:sonnet|opus|haiku)-([5-9]|\d{2,})(?:-|$)|claude-(?:fable|mythos)/i;

/** True when `model` is a Claude model newer than 4.5 (see module header). */
export function isModelPost45(model: unknown): boolean {
  return typeof model === "string" && POST_45_RE.test(model);
}
