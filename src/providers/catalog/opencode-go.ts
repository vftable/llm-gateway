import {
  OpenAICompatibleAdapter,
  type UsageCtx,
  type KeyUsageResult,
} from "../base";
import { WireKind } from "../../types";
import type { ProviderKeyUsageWindow } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

// OpenCode Go — a paid subscription tier at opencode.ai/go, distinct from Zen.
// Supports both /chat/completions and /messages.
//
// Quota display: no public REST endpoint (open GitHub issue for /zen/v1/balance).
// Uses HTML scraping of the workspace dashboard page, same approach as the
// opencode-quota community tool (github.com/slkiser/opencode-quota).
//
// Required metadata keys on each ProviderKey:
//   workspaceId  — the workspace slug from the URL (opencode.ai/workspace/<id>/go)
//   authCookie   — the value of the "auth" cookie from an active browser session
//
// Parse strategy A (SolidJS SSR hydration):
//   rollingUsage:$R[0]={usagePercent:12.3,resetInSec:1234}
//   Both field orderings (usagePercent first or resetInSec first) are tried.
//
// Parse strategy B (data-slot HTML, newer format):
//   data-slot="usage-item" ... data-slot="usage-label">Rolling Usage<
//   data-slot="usage-value">12< ... data-slot="reset-time">1 hour 56 minutes<

const WORKSPACE_URL = (workspaceId: string) =>
  `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`;

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;

interface UsageWindow {
  usagePercent: number;
  resetInSec: number;
}

function extractWindowSsr(html: string, key: string): UsageWindow | null {
  // SolidJS SSR format: rollingUsage:$R[N]={usagePercent:N,resetInSec:N}
  // Field order varies — try both orderings.
  const base = key + String.raw`:\$R\[\d+\]=\{[^}]*`;
  const pctFirst = new RegExp(
    base + `usagePercent:${NUM}[^}]*resetInSec:${NUM}`,
  );
  const resetFirst = new RegExp(
    base + `resetInSec:${NUM}[^}]*usagePercent:${NUM}`,
  );

  const m1 = pctFirst.exec(html);
  if (m1) {
    const usagePercent = parseFloat(m1[1]);
    const resetInSec = parseFloat(m1[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec))
      return { usagePercent, resetInSec };
  }

  const m2 = resetFirst.exec(html);
  if (m2) {
    const resetInSec = parseFloat(m2[1]);
    const usagePercent = parseFloat(m2[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec))
      return { usagePercent, resetInSec };
  }

  return null;
}

function parseHumanReadableTime(s: string): number | null {
  const n = s.toLowerCase().replace(/\s+/g, " ").trim();
  if (["reset-now", "reset now", "now", "resets now"].includes(n)) return 0;
  let total = 0;
  let matched = false;
  const day = n.match(/(\d+(?:\.\d+)?)\s*days?/);
  const hr = n.match(/(\d+(?:\.\d+)?)\s*hours?/);
  const min = n.match(/(\d+(?:\.\d+)?)\s*minutes?/);
  const sec = n.match(/(\d+(?:\.\d+)?)\s*seconds?/);
  if (day) {
    total += parseFloat(day[1]) * 86400;
    matched = true;
  }
  if (hr) {
    total += parseFloat(hr[1]) * 3600;
    matched = true;
  }
  if (min) {
    total += parseFloat(min[1]) * 60;
    matched = true;
  }
  if (sec) {
    total += parseFloat(sec[1]);
    matched = true;
  }
  return matched ? total : null;
}

function extractWindowsDataSlot(html: string): Record<string, UsageWindow> {
  const result: Record<string, UsageWindow> = {};
  const items = html.split(/data-slot="usage-item"/);
  for (let i = 1; i < items.length; i++) {
    const chunk = items[i];
    const labelM = chunk.match(/data-slot="usage-label">([^<]+)</);
    if (!labelM) continue;
    const label = labelM[1].trim().toLowerCase();

    const usageM = chunk.match(
      /data-slot="usage-value">[^0-9]*(\d+(?:\.\d+)?)/,
    );
    if (!usageM) continue;
    const usagePercent = parseFloat(usageM[1]);

    const resetM = chunk.match(
      /data-slot="(reset-time|reset-now)">([\s\S]*?)<\/span>/,
    );
    if (!resetM) continue;
    const resetContent = resetM[2]
      .replace(/<!--\$-->/g, "")
      .replace(/<!--\/-->/g, "")
      .replace(/Resets?\s*in\s*/i, "")
      .trim();
    const resetInSec =
      resetM[1] === "reset-now" ? 0 : parseHumanReadableTime(resetContent);

    if (
      !Number.isFinite(usagePercent) ||
      resetInSec === null ||
      !Number.isFinite(resetInSec)
    )
      continue;

    const key = label.includes("rolling")
      ? "rolling"
      : label.includes("weekly")
        ? "weekly"
        : label.includes("monthly")
          ? "monthly"
          : null;
    if (key) result[key] = { usagePercent, resetInSec };
  }
  return result;
}

function extractWindows(html: string): {
  rolling: UsageWindow | null;
  weekly: UsageWindow | null;
  monthly: UsageWindow | null;
} {
  // Try SolidJS SSR format first
  let rolling = extractWindowSsr(html, "rollingUsage");
  let weekly = extractWindowSsr(html, "weeklyUsage");
  let monthly = extractWindowSsr(html, "monthlyUsage");

  // Fall back to data-slot HTML format
  if (!rolling && !weekly && !monthly) {
    const ds = extractWindowsDataSlot(html);
    rolling = ds.rolling ?? null;
    weekly = ds.weekly ?? null;
    monthly = ds.monthly ?? null;
  }

  return { rolling, weekly, monthly };
}

function toWindow(
  id: string,
  label: string,
  w: UsageWindow | null,
): ProviderKeyUsageWindow | null {
  if (!w) return null;
  return {
    id,
    label,
    used: w.usagePercent,
    limit: 100,
    unit: "percent",
    resetsAt: new Date(Date.now() + w.resetInSec * 1000).toISOString(),
  };
}

class OpenCodeGoAdapter extends OpenAICompatibleAdapter {
  supportsKeyUsage(_ctx: UsageCtx): boolean {
    return true;
  }

  async keyUsage(ctx: UsageCtx): Promise<KeyUsageResult> {
    const { workspaceId, authCookie } = ctx.keyMetadata as Record<
      string,
      string
    >;

    if (!workspaceId || !authCookie) {
      return {
        windows: [],
        unavailable: true,
        message:
          'Set "workspaceId" and "authCookie" in this key\'s metadata to enable quota display.',
      };
    }

    if (!ctx.enabled) {
      return {
        windows: [],
        unavailable: true,
        message: "Key disabled — usage not queried.",
      };
    }

    let html: string;
    try {
      const res = await ctx.request(WORKSPACE_URL(workspaceId), {
        method: "GET",
        headers: {
          cookie: `auth=${authCookie}`,
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0",
          accept: "text/html",
        },
        signal: ctx.signal,
      });
      if (!res.ok) {
        return {
          windows: [],
          unavailable: true,
          message: `Dashboard returned HTTP ${res.status} — check workspaceId and authCookie.`,
        };
      }
      html = res.text;
    } catch (err) {
      return {
        windows: [],
        unavailable: true,
        message: `Scrape failed: ${(err as Error).message}`,
      };
    }

    const { rolling, weekly, monthly } = extractWindows(html);

    if (!rolling && !weekly && !monthly) {
      return {
        windows: [],
        unavailable: true,
        message:
          "Could not parse quota data — page structure may have changed, or session expired.",
      };
    }

    const windows: ProviderKeyUsageWindow[] = [];
    const w1 = toWindow("rolling-5h", "Prompts (5h)", rolling);
    if (w1) windows.push(w1);
    const w2 = toWindow("weekly", "Prompts (weekly)", weekly);
    if (w2) windows.push(w2);
    const w3 = toWindow("monthly", "Prompts (monthly)", monthly);
    if (w3) windows.push(w3);

    return { windows };
  }
}

export const opencodeGo = new OpenCodeGoAdapter({
  id: "opencode-go",
  label: "OpenCode Go",
  blurb:
    "OpenCode Go subscription — both /chat/completions and /messages endpoints.",
  brand: "opencode",
  docsUrl: "https://opencode.ai/docs/go/",
  defaults: {
    baseUrl: "https://opencode.ai/zen/go",
    endpoints: [WireKind.Chat, WireKind.Messages],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    {
      key: "name",
      label: "Name",
      placeholder: "opencode-go",
      required: true,
    },
    {
      key: "apiKeys",
      label: "API key",
      required: true,
      hint: "One per line — rotated round-robin.",
    },
    {
      key: "baseUrl",
      label: "Base URL",
      editable: true,
      hint: "Default: https://opencode.ai/zen/go",
    },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
