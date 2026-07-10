// The thinking/reasoning tag vocabulary — defined in ONE place.
//
// Both the non-streaming converter (converter.ts) and the streaming parser
// (stream.ts) recognize the same set of tags. Keeping the pattern here means the
// vocabulary is edited once instead of kept in sync across four regexes.
//
// Recognized tags (case-insensitive):
//   <thinking>…</thinking>   (also the `antml` namespace prefix: `<thinking>`)
//   <think>…</think>
//   <reasoning>…</reasoning>
//   <thinking_mode>…</thinking_mode>
// The `antml` prefix is only valid on <thinking>/<think> (Anthropic models), not
// on <reasoning> or <thinking_mode).

// The alternation of tag names, as a non-anchored source fragment. Wrap it in
// `(?:…)` at each use site. NOT a RegExp itself so it composes into open/close
// forms without duplicating the vocabulary.
export const TAG_BODY =
  "(?:antml(?:[:\\s]+))?think(?:ing)?|reasoning|thinking_mode";

// `<thinking>` opening tag (allows surrounding whitespace).
export const OPEN_TAG_SRC = `<\\s*(?:${TAG_BODY})\\s*>`;
// `</thinking>` closing tag.
export const CLOSE_TAG_SRC = `<\\s*\\/\\s*(?:${TAG_BODY})\\s*>`;
