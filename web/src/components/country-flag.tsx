// Inline country flags via twemoji. A 2-letter ISO code is turned into its
// regional-indicator emoji, then twemoji renders that to a CDN SVG <img> so the
// flag looks identical across platforms (native emoji flags don't render on
// Windows). Mirrors the inline-SVG pattern used by model-icon.tsx.

import { useMemo } from "react";
import twemoji from "@twemoji/api";
import { cn } from "@/lib/utils";

// A compact, commonly-useful country list for the picker. Not exhaustive — the
// backend accepts any 2-letter code, so this is just the dropdown's convenience
// set (ordered roughly by prevalence of proxy/egress regions).
export const COUNTRIES: Array<{ code: string; name: string }> = [
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "NL", name: "Netherlands" },
  { code: "CA", name: "Canada" },
  { code: "JP", name: "Japan" },
  { code: "SG", name: "Singapore" },
  { code: "AU", name: "Australia" },
  { code: "IN", name: "India" },
  { code: "BR", name: "Brazil" },
  { code: "KR", name: "South Korea" },
  { code: "HK", name: "Hong Kong" },
  { code: "TW", name: "Taiwan" },
  { code: "IE", name: "Ireland" },
  { code: "SE", name: "Sweden" },
  { code: "CH", name: "Switzerland" },
  { code: "ES", name: "Spain" },
  { code: "IT", name: "Italy" },
  { code: "PL", name: "Poland" },
  { code: "FI", name: "Finland" },
  { code: "NO", name: "Norway" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "RU", name: "Russia" },
  { code: "CN", name: "China" },
];

const NAME_BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c.name]));

// Convert "US" -> "🇺🇸" (two regional-indicator symbols).
function codeToEmoji(code: string): string | null {
  const cc = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return null;
  const A = 0x1f1e6; // regional indicator "A"
  return (
    String.fromCodePoint(A + cc.charCodeAt(0) - 65) +
    String.fromCodePoint(A + cc.charCodeAt(1) - 65)
  );
}

export function CountryFlag({
  code,
  className,
  title,
}: {
  code: string | null | undefined;
  className?: string;
  title?: string;
}) {
  const html = useMemo(() => {
    if (!code) return null;
    const emoji = codeToEmoji(code);
    if (!emoji) return null;
    // twemoji.parse returns an <img> string pointing at the CDN SVG.
    return twemoji.parse(emoji, { folder: "svg", ext: ".svg" });
  }, [code]);

  if (!html) return null;
  const label = title || NAME_BY_CODE.get(code!.toUpperCase()) || code!;
  return (
    <span
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center [&>img]:size-full [&>img]:rounded-[1px]",
        className,
      )}
      role="img"
      aria-label={label}
      title={label}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function countryName(code: string | null | undefined): string | null {
  if (!code) return null;
  return NAME_BY_CODE.get(code.toUpperCase()) ?? code.toUpperCase();
}
