import {
  OpenAICompatibleAdapter,
  type UsageCtx,
  type KeyUsageResult,
} from "../base";
import { WireKind } from "../../types";
import type { ProviderKeyUsageWindow } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

// ClinePass — Cline's flat-rate subscription ($9.99/month).
// Base URL: https://api.cline.bot  Base path: /api/v1
// Auth: Authorization: Bearer <key>
// Chat-only (OpenAI-compatible).
//
// Quota endpoint: GET https://api.cline.bot/api/v1/users/me/plan/usage-limits
// Response shape:
//   { success: true, data: { limits: [{ type: "five_hour"|"weekly"|"monthly", percentUsed: 0..100 }] } }

const USAGE_PATH = "/api/v1/users/me/plan/usage-limits";

interface ClineLimitEntry {
  type?: string;
  percentUsed?: number;
}

interface ClinePlanUsage {
  success?: boolean;
  data?: {
    limits?: ClineLimitEntry[];
  };
}

const WINDOW_META: Record<string, { id: string; label: string }> = {
  five_hour: { id: "5h", label: "Prompts (5h)" },
  weekly: { id: "weekly", label: "Prompts (weekly)" },
  monthly: { id: "monthly", label: "Prompts (monthly)" },
};

class ClinePassAdapter extends OpenAICompatibleAdapter {
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
      res = await ctx.request(ctx.baseUrl.replace(/\/+$/, "") + USAGE_PATH, {
        method: "GET",
        headers: {
          authorization: `Bearer ${ctx.apiKey}`,
          accept: "application/json",
        },
        signal: ctx.signal,
      });
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
        message: `Usage endpoint returned HTTP ${res.status}`,
      };
    }

    let data: ClinePlanUsage;
    try {
      data = res.json() as ClinePlanUsage;
    } catch {
      return {
        windows: [],
        unavailable: true,
        message: "Usage endpoint returned a non-JSON response.",
      };
    }

    const limits = data?.data?.limits;
    if (!Array.isArray(limits) || !limits.length) {
      return {
        windows: [],
        unavailable: true,
        message: "No usage limits returned from Cline API.",
      };
    }

    const windows: ProviderKeyUsageWindow[] = [];
    for (const entry of limits) {
      const meta = WINDOW_META[entry.type ?? ""];
      if (!meta) continue;
      const pct = entry.percentUsed ?? 0;
      windows.push({
        id: meta.id,
        label: meta.label,
        used: pct,
        limit: 100,
        unit: "percent",
      });
    }

    if (!windows.length) {
      return {
        windows: [],
        unavailable: true,
        message: "No recognized quota windows in Cline API response.",
      };
    }

    return { windows };
  }
}

export const clinepass = new ClinePassAdapter({
  id: "clinepass",
  label: "ClinePass",
  blurb: "Cline flat-rate subscription — OpenAI-compatible chat endpoint.",
  brand: "cline",
  docsUrl: "https://cline.bot/",
  defaults: {
    baseUrl: "https://api.cline.bot",
    basePath: "/api/v1",
    modelsPath: "/models",
    endpoints: [WireKind.Chat],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    {
      key: "name",
      label: "Name",
      placeholder: "clinepass",
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
      hint: "Default: https://api.cline.bot",
    },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
