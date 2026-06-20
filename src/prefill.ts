// Claude 4.6+ prefill auto-fix.
//
// Starting with Claude 4.6, Anthropic removed assistant-message prefill
// support: a request whose final message is an `assistant` turn is rejected
// with a 400. This appends a trailing `user` message (with `tool_result`
// blocks when the assistant turn contained `tool_use` blocks, as the
// Anthropic API requires) so such requests go through cleanly.
//
// Ported from the LiteLLM AppendContinueCallback for this TypeScript gateway.
//   - https://platform.claude.com/docs/en/about-claude/models/migration-guide
//   - https://github.com/BerriAI/litellm/issues/22930

// Matches Claude models WITHOUT assistant prefill support:
//   - the 4.x line at 4.6 and above (claude-sonnet-4-6, claude-opus-4-8, ...)
//   - any major version >= 5 (claude-sonnet-5-..., claude-opus-5-..., ...)
//   - the Fable / Mythos lines (claude-fable-5, claude-mythos, ...)
const NO_PREFILL_RE =
  /claude-(?:sonnet|opus|haiku)-4-([6-9]|\d{2,})(?:-|$)|claude-(?:sonnet|opus|haiku)-([5-9]|\d{2,})(?:-|$)|claude-(?:fable|mythos)/i;

export function modelNeedsPrefillFix(model: string): boolean {
  if (typeof model !== "string" || model === "") return false;
  return NO_PREFILL_RE.test(model.toLowerCase());
}

// Extract `id`s from any `tool_use` blocks in an Anthropic-shaped content
// array. Returns [] for plain-string content or unrecognized shapes.
function extractToolUseIds(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "tool_use"
    ) {
      const id = (block as { id?: unknown }).id;
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}

// Build the trailing `user` message to append. If the assistant turn carried
// `tool_use` blocks, the API requires matching `tool_result` blocks — we send
// a minimal "continue" result for each. Otherwise a plain text nudge.
export function buildContinueUserMessage(content: unknown): {
  role: "user";
  content: unknown;
} {
  const toolIds = extractToolUseIds(content);
  if (toolIds.length > 0) {
    return {
      role: "user",
      content: toolIds.map((tool_use_id) => ({
        type: "tool_result",
        tool_use_id,
        content: "continue",
      })),
    };
  }
  return { role: "user", content: "continue" };
}

// A message in either the Anthropic (/v1/messages) or OpenAI
// (/v1/chat/completions) shape — both use { role, content }.
interface LikeMessage {
  role?: unknown;
  content?: unknown;
}

export interface PrefillResult {
  appended: boolean;
  toolIds: string[];
  before: number;
  after: number;
}

// In-place: append a `user` message to `body.messages` when
//   - the resolved `model` is a Claude 4.6+ model, AND
//   - the last message is an `assistant` turn.
// Returns whether it appended (and the counts) so the caller can log it.
// Leaves the body untouched in every other case.
export function applyPrefillFix(
  body: { messages?: unknown; model?: unknown } | undefined | null,
  model: string,
): PrefillResult {
  const noop: PrefillResult = {
    appended: false,
    toolIds: [],
    before: 0,
    after: 0,
  };
  if (!body || typeof body !== "object") return noop;
  if (!modelNeedsPrefillFix(model)) return noop;

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return noop;

  const last = messages[messages.length - 1] as LikeMessage | undefined;
  if (!last || last.role !== "assistant") return noop;

  const userMsg = buildContinueUserMessage(last.content);
  // Reassign on a known-shaped body so the proxy re-serializes the new tail.
  (body as { messages: unknown[] }).messages = [...messages, userMsg];

  return {
    appended: true,
    toolIds: extractToolUseIds(last.content),
    before: messages.length,
    after: messages.length + 1,
  };
}
