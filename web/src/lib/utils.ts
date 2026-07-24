import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function fmtNum(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US").format(n);
}
// Format a dollar amount: < $0.01 → 4 decimals, otherwise 2.
export function fmtUsd(n: number): string {
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

// Display label for a wire-format / model-type value. CSS `text-transform:
// capitalize` mangles "openai" into "Openai"; this preserves the correct casing
// ("OpenAI", "Anthropic") and title-cases anything unknown.
export function formatLabel(v: string | null | undefined): string {
  if (!v) return "—";
  const known: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
  };
  return known[v.toLowerCase()] ?? v.charAt(0).toUpperCase() + v.slice(1);
}

// Display label for an auth scheme (the raw values are lowercase ids).
export function authSchemeLabel(v: string | null | undefined): string {
  if (!v) return "—";
  const known: Record<string, string> = {
    bearer: "Bearer",
    xapikey: "X-Api-Key",
    both: "Both",
    passthrough: "Passthrough",
  };
  return known[v.toLowerCase()] ?? v.charAt(0).toUpperCase() + v.slice(1);
}

// Canonical label for a provider's conversion policy. ONE phrasing used
// everywhere (card badge, overview, config select, wizard) so the meaning is
// unambiguous: who translates between the client's wire format and the
// provider's — the provider itself (native) or the gateway.
export function conversionLabel(nativeConversion: boolean): string {
  return nativeConversion ? "Provider converts" : "Gateway converts";
}

// One-line explanation of the conversion policy, for tooltips/help text.
export function conversionHelp(nativeConversion: boolean): string {
  return nativeConversion
    ? "This provider accepts every wire format directly and converts internally — the gateway forwards the request unchanged."
    : "The gateway converts each request/response between the client's wire format and this provider's native format.";
}

// "1 key", "27 keys" — count + correctly pluralized noun. Pass an explicit
// plural for irregular words; default appends "s".
export function plural(
  n: number,
  singular: string,
  pluralForm?: string,
): string {
  return `${n} ${n === 1 ? singular : (pluralForm ?? singular + "s")}`;
}

// Compact token-count label. Keeps small counts exact (so a low-usage chart
// axis reads "250 / 500 / 750" instead of collapsing to "0k / 1k"), and only
// switches to k/M once the number is large enough for that to be readable:
//   0..999      -> exact           (0, 42, 750, 999)
//   1k..999k    -> k, ≤1 decimal   (1k, 1.5k, 16k, 200k)
//   ≥1M         -> M, ≤2 decimals  (1M, 1.05M, 12.5M)
// Trailing zeros are trimmed so labels stay tidy (1.0k -> 1k, 2.50M -> 2.5M).
export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000)
    return `${trimDecimals(n / 1000, abs < 10_000 ? 1 : 0)}k`;
  return `${trimDecimals(n / 1_000_000, abs < 10_000_000 ? 2 : 1)}M`;
}

// Round to `places` decimals, dropping only *fractional* trailing zeros so
// whole numbers keep their value (200 -> "200", 1.50 -> "1.5", 1.0 -> "1").
function trimDecimals(n: number, places: number): string {
  return String(parseFloat(n.toFixed(places)));
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Client-side mirror of the backend's standardPath()/endpointPathFor()
// (src/providers/base.ts) — same rule, so the wizard's and the detail page's
// "resolved URL" preview always agrees with what the server will actually
// compose: an explicit per-kind override wins; otherwise a bare basePath set
// means only the kind's suffix is appended ("/chat/completions"), and an EMPTY
// basePath means the implicit "/v1" prefix is added ("/v1/chat/completions").
// basePath REPLACES "/v1" — it is not layered on top of it. If you need /v1 in
// the final path, include it in basePath yourself (e.g. "/v1beta/openai").
export function endpointPathPreview(
  kind: "chat" | "messages" | "responses",
  basePath: string | null | undefined,
  endpointPaths?: Partial<Record<"chat" | "messages" | "responses", string>>,
): string {
  const override = endpointPaths?.[kind];
  if (override) return override;
  const bare =
    kind === "messages"
      ? "/messages"
      : kind === "responses"
        ? "/responses"
        : "/chat/completions";
  return basePath ? bare : "/v1" + bare;
}

// The full resolved upstream URL for a hop: origin + basePath + endpoint path.
// Mirrors composeUrl() (base.ts) — string concatenation, not `new URL()`,
// which would drop basePath as a path prefix. Returns "" when there's not
// enough to compose yet (no origin or no kind to preview).
export function resolvedUrlPreview(
  baseUrl: string | null | undefined,
  basePath: string | null | undefined,
  kind: "chat" | "messages" | "responses" | undefined,
  endpointPaths?: Partial<Record<"chat" | "messages" | "responses", string>>,
): string {
  const origin = (baseUrl ?? "").replace(/\/+$/, "");
  if (!origin || !kind) return "";
  return (
    origin +
    (basePath ?? "") +
    endpointPathPreview(kind, basePath, endpointPaths)
  );
}

// The Host header the gateway would derive from a base URL when no override is
// set (mirrors hostFromUrl() in src/gateway/url.ts) — used as the Host header
// override field's placeholder so the blank/default value is visible, not just
// described in a hint. "" when baseUrl isn't a parseable absolute URL yet.
export function hostFromUrl(baseUrl: string | null | undefined): string {
  try {
    return new URL(baseUrl ?? "").host;
  } catch {
    return "";
  }
}

export function summarizeTestData(data: unknown): string | null {
  if (data == null) return null;
  if (typeof data === "string") return data.slice(0, 200);
  if (typeof data === "object") {
    try {
      return JSON.stringify(data).slice(0, 200);
    } catch {
      return null;
    }
  }
  return null;
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "—";
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Base path the UI is served under. The gateway injects <base href> into
// index.html from config.json webBasePath; in dev (no tag) this is "/".
export function webBase(): string {
  return new URL(".", document.baseURI).pathname;
}
