// Editable JSON field with live syntax highlighting.
//
// A thin wrapper over react-simple-code-editor: it renders a transparent
// <textarea> over a highlighted <pre>, keeping the caret, selection and scroll
// perfectly aligned (something a hand-rolled overlay gets wrong). We supply our
// OWN highlighter that reuses the app's `jt-*` token colors (see index.css), so
// an editable field matches the read-only JsonTree in both themes.
//
// Highlighting is purely visual; validity is still the caller's concern (it
// JSON.parses on save and surfaces its own error), so a half-typed value is
// never rejected mid-keystroke.

import Editor from "react-simple-code-editor";
import { cn } from "@/lib/utils";

// Escape text for safe injection into the highlighted <pre> innerHTML.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Tokenize a JSON-ish string into span-wrapped HTML. Tolerant of partial/invalid
// input (it's an editor) — anything unrecognized is emitted as plain text. Order
// matters: strings first (so braces inside them aren't mistaken for punctuation),
// then literals, numbers, punctuation. Object KEYS (a string immediately followed
// by a colon) get the label color; other strings get the string color.
const TOKEN =
  /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],:])/g;

function highlightJson(code: string): string {
  let out = "";
  let last = 0;
  for (let m = TOKEN.exec(code); m; m = TOKEN.exec(code)) {
    out += escapeHtml(code.slice(last, m.index));
    const [tok, key, str, lit, num, punct] = m;
    if (key !== undefined) {
      // "field": — color the field name, keep the trailing colon as punctuation.
      const name = key.replace(/\s*:\s*$/, "");
      out += `<span class="jt-label">${escapeHtml(name)}</span><span class="jt-punct">:</span>`;
    } else if (str !== undefined) {
      out += `<span class="jt-string">${escapeHtml(str)}</span>`;
    } else if (lit !== undefined) {
      const cls = lit === "null" ? "jt-null" : "jt-boolean";
      out += `<span class="${cls}">${escapeHtml(lit)}</span>`;
    } else if (num !== undefined) {
      out += `<span class="jt-number">${escapeHtml(num)}</span>`;
    } else if (punct !== undefined) {
      out += `<span class="jt-punct">${escapeHtml(punct)}</span>`;
    } else {
      out += escapeHtml(tok);
    }
    last = m.index + tok.length;
  }
  out += escapeHtml(code.slice(last));
  return out;
}

export function JsonEditor({
  value,
  onChange,
  placeholder,
  minRows = 3,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  minRows?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        // Match the app's input chrome (border, radius, focus ring) so the field
        // reads like the Textarea it replaces.
        "jt-container rounded-lg border border-input bg-background text-xs transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50 dark:bg-input/30",
        className,
      )}
      style={{ minHeight: `${minRows * 1.55 + 1.5}em` }}
    >
      <Editor
        value={value}
        onValueChange={onChange}
        highlight={highlightJson}
        placeholder={placeholder}
        padding={10}
        textareaClassName="focus:outline-none"
        // The wrapper carries the mono font (jt-container); keep the two layers
        // pixel-identical so the caret lines up with the highlighted glyphs.
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.75rem",
          lineHeight: 1.55,
        }}
      />
    </div>
  );
}
