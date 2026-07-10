// Inline country flags via the Twemoji CDN. A 2-letter ISO code becomes its
// regional-indicator codepoints, which name the Twemoji SVG — so the flag looks
// identical across platforms (native emoji flags don't render on Windows).
//
// We build the <img> in JSX (rather than twemoji.parse + dangerouslySetInnerHTML)
// so we can attach an onError fallback: if the CDN is unreachable (offline /
// air-gapped deploy / blocked), we show the 2-letter code instead of a broken
// image or the raw-emoji tofu that Windows would render. Explicit sizing avoids
// layout shift while the SVG loads.

import { useState } from "react";
import { cn } from "@/lib/utils";

// Twemoji CDN base (jdecked fork, pinned) — the same URL @twemoji/api composes.
const TWEMOJI_BASE =
  "https://cdn.jsdelivr.net/gh/jdecked/twemoji@17.0.3/assets";

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

// Convert "US" -> "1f1fa-1f1f8" (the two regional-indicator codepoints, hex,
// dash-joined) — the Twemoji SVG file naming. Null for a non-2-letter code.
function codeToTwemojiName(code: string): string | null {
  const cc = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return null;
  const A = 0x1f1e6; // regional indicator "A"
  const a = A + cc.charCodeAt(0) - 65;
  const b = A + cc.charCodeAt(1) - 65;
  return `${a.toString(16)}-${b.toString(16)}`;
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
  const [failed, setFailed] = useState(false);
  const name = code ? codeToTwemojiName(code) : null;
  if (!name) return null;
  const label = title || NAME_BY_CODE.get(code!.toUpperCase()) || code!;

  return (
    <span
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-xs",
        className,
      )}
      role="img"
      aria-label={label}
      title={label}
    >
      {failed ? (
        // CDN unreachable — a legible 2-letter code beats a broken image / tofu.
        <span className="text-[0.5rem] font-semibold leading-none tracking-tight text-muted-foreground">
          {code!.toUpperCase()}
        </span>
      ) : (
        <img
          src={`${TWEMOJI_BASE}/svg/${name}.svg`}
          alt=""
          width={16}
          height={16}
          loading="lazy"
          draggable={false}
          className="size-full"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

export function countryName(code: string | null | undefined): string | null {
  if (!code) return null;
  return NAME_BY_CODE.get(code.toUpperCase()) ?? code.toUpperCase();
}
