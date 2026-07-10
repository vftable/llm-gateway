// Safe JSON parse helpers for DB TEXT columns (transforms, capabilities,
// extra_headers, endpoints, …). A malformed or absent value degrades to the
// caller's fallback rather than throwing — these columns are best-effort and a
// bad row must never crash a read. Single source for the "try JSON.parse,
// validate shape, else fall back" pattern that otherwise recurs per column.

// Parse a JSON object column. Returns the parsed value only when it's a plain
// object (not an array/primitive); otherwise the fallback.
export function parseJsonObject<T>(
  raw: string | null | undefined,
  fallback: T,
): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as T;
  } catch {
    /* fall through */
  }
  return fallback;
}

// Parse a JSON array column. Returns [] unless the value is an array; an optional
// type guard filters elements (e.g. keep only strings).
export function parseJsonArray<T = unknown>(
  raw: string | null | undefined,
  guard?: (v: unknown) => v is T,
): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed))
      return guard ? parsed.filter(guard) : (parsed as T[]);
  } catch {
    /* fall through */
  }
  return [];
}

// Common element guard for string arrays.
export const isString = (v: unknown): v is string => typeof v === "string";
