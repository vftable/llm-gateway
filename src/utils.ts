// Shared utilities for the LLM gateway.

// Zero-width and invisible Unicode characters that models sometimes emit.
// Stripped from all upstream response text as a flat pre-process so tags are
// never silently broken by an invisible character sitting inside a tag.
const INVISIBLE_RE = /[\u200B\u200C\u200D\uFEFF\u2060]/g;
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_RE, "");
}
