import {
  OpenAICompatibleAdapter,
  type UsageCtx,
  type KeyUsageResult,
} from "../base";
import { WireKind } from "../../types";
import type { ProviderKeyUsageWindow } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

// Z.ai GLM Coding Plan — OpenAI-compatible, but the chat/models paths sit under
// a deep prefix (/api/coding/paas/v4), not /v1. The adapter composes
//   origin + basePath + suffix
// so the upstream URL builds as:
//   https://api.z.ai + /api/coding/paas/v4 + /chat/completions
//   => https://api.z.ai/api/coding/paas/v4/chat/completions
//
// keyUsage() queries GET {origin}/api/monitor/usage/quota/limit (Bearer auth) —
// a SIBLING path, not under /api/coding/paas/v4, so it's built from ctx.baseUrl
// directly rather than ctx.resolve() (which would compose through basePath).
// Response shape:
//   {
//     "code": 200,
//     "data": {
//       "level": "lite",
//       "limits": [
//         {
//           "type": "TOKENS_LIMIT",       // token/prompt quota, a ROLLING window
//           "unit": 3, "number": 5,       // -> "5 Hour" window (unit=3,number=5)
//           "percentage": 40.5,
//           "nextResetTime": 1785763345975  // Unix MILLISECONDS
//         },
//         {
//           "type": "TOKENS_LIMIT",
//           "unit": 6, "number": 1,       // -> "Weekly" window (unit=6,number=1)
//           "percentage": 52.0,
//           "nextResetTime": 1786195345975
//         },
//         {
//           "type": "TIME_LIMIT",         // MCP TOOL-CALL usage, a 1-MONTH period
//           "percentage": 12.3,
//           "currentValue": 123,
//           "usage": 1000,
//           "usageDetails": [{ "modelCode": "search-prime", "usage": 5678 }, …]
//         }
//       ]
//     },
//     "success": true
//   }
//
// The `type` names are misleading relative to their content — cross-checked
// against github.com/guyinwonder168/opencode-glm-quota (an OpenCode plugin
// hitting this same endpoint) and its test fixtures:
//
//   TOKENS_LIMIT  the actual token/prompt quota, NOT a raw "tokens" count. The
//                 5-hour window (unit=3,number=5) is ALWAYS shown, even at 0%,
//                 since every plan tier has one — the dashboard never silently
//                 drops it. The weekly window (unit=6,number=1) is only shown
//                 when the upstream actually returns that entry — lower tiers
//                 (e.g. Lite) don't have a weekly quota at all, and a fabricated
//                 0% bar for a limit that doesn't exist would be misleading. No
//                 response observed ever carries an absolute total (only
//                 `percentage`), so the bar is built as used=percentage /
//                 limit=100 (a "% of window" bar, not a real count) —
//                 `unit: "requests"` is the closest fit in the shared UsageUnit
//                 vocabulary, not a literal request count.
//   TIME_LIMIT    MCP tool-call usage (web search / web read / zread) over a
//                 rolling month. Carries real `currentValue`/`usage` — mapped to
//                 a real "requests" window. No `nextResetTime` (monthly, not
//                 shown as a countdown upstream either).
//
// `usageDetails` (the TIME_LIMIT per-tool breakdown) has no home in
// ProviderKeyUsageWindow's flat shape and isn't surfaced. The key's `message`
// carries ONLY the plan level ("Plan: Lite") — nothing else is folded into it.

const QUOTA_LIMIT_PATH = "/api/monitor/usage/quota/limit";

interface GlmUsageDetail {
  modelCode?: string;
  usage?: number;
}

interface GlmLimit {
  type?: string;
  unit?: number;
  number?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
  /** Unix milliseconds. */
  nextResetTime?: number;
  usageDetails?: GlmUsageDetail[];
}

interface GlmQuotaData {
  limits?: GlmLimit[];
  level?: string;
}

interface GlmQuotaResponse {
  code?: number;
  msg?: string;
  data?: GlmQuotaData;
  success?: boolean;
}

// "lite" -> "Lite", "PRO" -> "Pro" — the API returns the plan level lowercase
// (and possibly other casings); the dashboard should read like a proper noun.
function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function isFiveHourWindow(l: GlmLimit): boolean {
  return l.unit === 3 && l.number === 5;
}
function isWeeklyWindow(l: GlmLimit): boolean {
  return l.unit === 6 && l.number === 1;
}

function tokenWindowLabel(l: GlmLimit): string {
  if (isFiveHourWindow(l)) return "Prompts (5h)";
  if (isWeeklyWindow(l)) return "Prompts (weekly)";
  if (typeof l.unit === "number" && typeof l.number === "number")
    return `Prompts (unit=${l.unit}, number=${l.number})`;
  return "Prompts";
}

// Builds a percentage-based bar (see header comment) for a TOKENS_LIMIT entry.
// `limit` is undefined when the upstream didn't return this window at all —
// still renders as a real 0% bar rather than being omitted.
function tokenWindow(
  id: string,
  label: string,
  limit: GlmLimit | undefined,
): ProviderKeyUsageWindow {
  const used = typeof limit?.percentage === "number" ? limit.percentage : 0;
  return {
    id,
    label,
    used,
    limit: 100,
    unit: "requests",
    ...(limit?.nextResetTime
      ? { resetsAt: new Date(limit.nextResetTime).toISOString() }
      : {}),
  };
}

class GlmAdapter extends OpenAICompatibleAdapter {
  supportsKeyUsage(_ctx: UsageCtx): boolean {
    return true;
  }

  async keyUsage(ctx: UsageCtx): Promise<KeyUsageResult> {
    if (!ctx.enabled) {
      return {
        windows: [],
        unavailable: true,
        message: "Key disabled — usage not queried.",
      };
    }

    let res;
    try {
      res = await ctx.request(
        ctx.baseUrl.replace(/\/+$/, "") + QUOTA_LIMIT_PATH,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${ctx.apiKey}`,
            accept: "application/json",
          },
          signal: ctx.signal,
        },
      );
    } catch (err) {
      return {
        windows: [],
        unavailable: true,
        message: `Usage query failed: ${(err as Error).message}`,
      };
    }

    if (!res.ok) {
      return {
        windows: [],
        unavailable: true,
        message: `Usage endpoint returned status ${res.status}`,
      };
    }

    let parsed: GlmQuotaResponse;
    try {
      parsed = res.json() as GlmQuotaResponse;
    } catch {
      return {
        windows: [],
        unavailable: true,
        message: "Usage endpoint returned a non-JSON response.",
      };
    }

    if (!parsed.success || !parsed.data) {
      return {
        windows: [],
        unavailable: true,
        message: parsed.msg || "Usage endpoint reported an error.",
      };
    }

    const limits = parsed.data.limits ?? [];
    const windows: ProviderKeyUsageWindow[] = [];

    // Prompts — the 5-hour window is ALWAYS shown (every tier has one), even
    // when the upstream reports 0% for it (see header comment). The weekly
    // window only appears when the upstream actually defines it — not every
    // plan tier has one, and a fabricated 0% bar for a nonexistent limit would
    // be misleading.
    const tokenLimits = limits.filter((l) => l.type === "TOKENS_LIMIT");
    const fiveHour = tokenLimits.find(isFiveHourWindow);
    const weekly = tokenLimits.find(isWeeklyWindow);
    windows.push(tokenWindow("tokens-5h", "Prompts (5h)", fiveHour));
    if (weekly) {
      windows.push(tokenWindow("tokens-weekly", "Prompts (weekly)", weekly));
    }
    // Any additional TOKENS_LIMIT window with an unrecognized unit/number is
    // still surfaced rather than silently dropped.
    for (const l of tokenLimits) {
      if (l === fiveHour || l === weekly) continue;
      windows.push(
        tokenWindow(
          `tokens-${l.unit ?? "x"}-${l.number ?? "x"}`,
          tokenWindowLabel(l),
          l,
        ),
      );
    }

    // MCP tool usage (TIME_LIMIT) — a real used/limit window, only when the
    // upstream actually supplies a total.
    const mcp = limits.find(
      (l) => l.type === "TIME_LIMIT" && typeof l.usage === "number",
    );
    if (mcp) {
      windows.push({
        id: "mcp-monthly",
        label: "MCP tools (monthly)",
        used: mcp.currentValue ?? 0,
        limit: mcp.usage as number,
        unit: "requests",
        ...(mcp.nextResetTime
          ? { resetsAt: new Date(mcp.nextResetTime).toISOString() }
          : {}),
      });
    }

    const level = parsed.data.level;
    return {
      windows,
      ...(level ? { message: `Plan: ${titleCase(level)}` } : {}),
    };
  }
}

export const glm = new GlmAdapter({
  id: "glm-coding",
  label: "GLM Coding Plan (Z.ai)",
  blurb:
    "Z.ai GLM coding-plan models — OpenAI-compatible under /api/coding/paas/v4.",
  brand: "zai",
  docsUrl: "https://docs.z.ai/",
  defaults: {
    baseUrl: "https://api.z.ai",
    basePath: "/api/coding/paas/v4",
    modelsPath: "/models",
    endpoints: [WireKind.Chat],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    { key: "name", label: "Name", placeholder: "glm-coding", required: true },
    {
      key: "apiKeys",
      label: "API key",
      placeholder: "…",
      required: true,
      hint: "One per line — rotated round-robin.",
    },
    {
      key: "baseUrl",
      label: "Base URL",
      editable: true,
      hint: "Origin only — the /api/coding/paas/v4 prefix is added automatically.",
    },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
