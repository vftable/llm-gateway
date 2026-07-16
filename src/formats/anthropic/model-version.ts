// Shared Claude model-version predicates — the ONE file that owns the regexes.
//
// Every hook that branches on model family (thinking-mode, thinking-config,
// sanitize-request, prefill) imports from here instead of keeping local copies.
//
// isModelPost45: strictly NEWER than 4.5 (4.6+, 5+, fable, mythos).
// isModelSamplingStripped: models that reject temperature/top_p/top_k (400).
// Family matchers: FABLE, MYTHOS, OPUS_47_PLUS, etc. — used by thinking-mode.

const POST_45_RE =
  /claude-(?:sonnet|opus|haiku)-4-([6-9]|\d{2,})(?:-|$)|claude-(?:sonnet|opus|haiku)-([5-9]|\d{2,})(?:-|$)|claude-(?:fable|mythos)/i;

/** True when `model` is a Claude model newer than 4.5. */
export function isModelPost45(model: unknown): boolean {
  return typeof model === "string" && POST_45_RE.test(model);
}

// --- sampling parameter support -------------------------------------------
// Fable, Mythos, Opus 4.7+, and Sonnet 5+ reject temperature/top_p/top_k.
// Opus 4.6, Sonnet 4.6, Haiku, and all older models accept them.
const SAMPLING_STRIPPED_RE =
  /claude-(?:fable|mythos)|claude-opus-4-([7-9]|\d{2,})|claude-sonnet-([5-9]|\d{2,})(?:-|$)/i;

export function isModelSamplingStripped(model: string): boolean {
  return SAMPLING_STRIPPED_RE.test(model);
}

// --- per-family matchers (used by thinking-mode) --------------------------
export const FABLE_RE = /claude-fable/i;
export const MYTHOS_RE = /claude-mythos(?!.*preview)/i;
export const MYTHOS_PREVIEW_RE = /claude-mythos.*preview/i;
export const OPUS_47_PLUS_RE = /claude-opus-4-([7-9]|\d{2,})/i;
export const OPUS_46_RE = /claude-opus-4-6/i;
export const SONNET_5_PLUS_RE = /claude-sonnet-([5-9]|\d{2,})(?:-|$)/i;
export const SONNET_46_RE = /claude-sonnet-4-6/i;
export const HAIKU_RE = /claude-haiku/i;
export const ADAPTIVE_UNSUPPORTED_RE = /haiku/i;
