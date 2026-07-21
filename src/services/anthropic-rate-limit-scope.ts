import { FABLE_MYTHOS_RE } from "../formats/model-version";
import {
  parseUnifiedRateLimitHeaders,
  type UnifiedRateLimitWindow,
} from "./anthropic-unified-usage";

export type RateLimitScope =
  | {
      scope: "global";
      reason: string;
    }
  | {
      scope: "model";
      modelClass: "fable";
      resetAt: number;
      reason: string;
    };

const EXHAUSTED_STATUSES = new Set(["rejected", "blocked", "rate_limited"]);
const SAFE_STATUSES = new Set(["allowed", "allowed_warning"]);

function exhausted(window: UnifiedRateLimitWindow | undefined): boolean {
  if (!window) return false;
  if (window.status !== undefined)
    return EXHAUSTED_STATUSES.has(window.status.toLowerCase());
  return window.utilization !== undefined && window.utilization >= 1;
}

function definitelyAvailable(
  window: UnifiedRateLimitWindow | undefined,
): boolean {
  if (!window) return false;
  if (window.status !== undefined)
    return SAFE_STATUSES.has(window.status.toLowerCase());
  return window.utilization !== undefined && window.utilization < 1;
}

export function classifyAnthropicRateLimit(
  input: {
    status: number;
    catalogId: string | null | undefined;
    upstreamModel: string;
    headers: Record<string, string | string[] | undefined>;
  },
  now = Date.now(),
): RateLimitScope {
  const global = (reason: string): RateLimitScope => ({
    scope: "global",
    reason,
  });
  if (input.status !== 429) return global("not an HTTP 429");
  if (input.catalogId !== "claude-code")
    return global("provider is not Claude Code");
  if (!FABLE_MYTHOS_RE.test(input.upstreamModel))
    return global("requested model is not Claude Fable/Mythos");

  const info = parseUnifiedRateLimitHeaders(input.headers);
  if (!info) return global("unified quota headers missing");
  const windows = new Map(info.windows.map((window) => [window.key, window]));
  const fable = windows.get("7d_oi");
  const fiveHour = windows.get("5h");
  const weekly = windows.get("7d");
  if (!exhausted(fable)) return global("Fable 7d_oi quota is not exhausted");
  if (!definitelyAvailable(fiveHour) || !definitelyAvailable(weekly))
    return global("general 5h/7d quota is exhausted or ambiguous");

  const resetIso = fable?.resetsAt ?? info.resetsAt;
  const parsedReset = resetIso ? Date.parse(resetIso) : Number.NaN;
  return {
    scope: "model",
    modelClass: "fable",
    resetAt:
      Number.isFinite(parsedReset) && parsedReset > now
        ? parsedReset
        : now + 60_000,
    reason: "Fable 7d_oi exhausted while general 5h/7d quota remains available",
  };
}
