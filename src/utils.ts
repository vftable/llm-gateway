// Shared utilities for the LLM gateway.

// Zero-width and invisible Unicode characters that models sometimes emit.
// Stripped from all upstream response text as a flat pre-process so tags are
// never silently broken by an invisible character sitting inside a tag.
const INVISIBLE_RE = /[\u200B\u200C\u200D\uFEFF\u2060]/g;
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_RE, "");
}

// Compact k/M count label \u2014 same rules as the dashboard's context-window
// formatter (web/src/lib/utils.ts fmtTokens), kept in sync by hand since the
// backend and web app are separate TS projects with no shared import path:
//   0..999      -> exact           (0, 42, 750, 999)
//   1k..999k    -> k, <=1 decimal  (1k, 1.5k, 16k, 200k)
//   >=1M        -> M, <=2 decimals (1M, 1.05M, 12.5M)
// Trailing zeros are trimmed (1.0k -> 1k, 2.50M -> 2.5M) so a 500,000 rate
// reads "500k" instead of a naive toFixed(0) rounding 0.5 up to a misleading
// "1M".
export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000)
    return `${trimDecimals(n / 1000, abs < 10_000 ? 1 : 0)}k`;
  return `${trimDecimals(n / 1_000_000, abs < 10_000_000 ? 2 : 1)}M`;
}

function trimDecimals(n: number, places: number): string {
  return String(parseFloat(n.toFixed(places)));
}
