// Shared model-version predicates — the ONE file that owns the regexes.
//
// Every hook that branches on model family imports from here instead of
// keeping local copies. Covers both Claude and OpenAI model families.
//
// Claude:
//   isModelPost45: strictly NEWER than 4.5 (4.6+, 5+, fable, mythos).
//   isModelSamplingStripped: models that reject temperature/top_p/top_k (400).
//   Family matchers: FABLE, MYTHOS, OPUS_47_PLUS, etc. — used by thinking-mode.
//
// OpenAI / GPT:
//   isGpt56Plus: GPT-5.6 and above (supports max effort, no unencrypted thinking).
//   isGpt5Family: GPT-5.x (supports xhigh effort).

// ---- Claude ----------------------------------------------------------------

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

// ---- OpenAI / GPT ---------------------------------------------------------

const GPT56_RE = /^gpt-?5[\.\-]?[6-9]/i;
const GPT5_RE = /^gpt-?5/i;

/** True when `model` is GPT-5.6 or above. */
export function isGpt56Plus(model: unknown): boolean {
  return typeof model === "string" && GPT56_RE.test(model);
}

/** True when `model` is any GPT-5 family model (5, 5-pro, 5.6, etc.). */
export function isGpt5Family(model: unknown): boolean {
  return typeof model === "string" && GPT5_RE.test(model);
}

// ---- Z.AI / GLM ------------------------------------------------------------

const GLM_RE = /^glm-(\d+)(?:\.(\d+))?(?:[-_]|$)/i;

/** True when `model` is a versioned GLM model id. */
export function isGlmModel(model: unknown): boolean {
  return typeof model === "string" && GLM_RE.test(model);
}

/** True for GLM-5.2 and later, where Z.AI supports reasoning_effort. */
export function isGlm52Plus(model: unknown): boolean {
  if (typeof model !== "string") return false;
  const match = GLM_RE.exec(model);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 2);
}
