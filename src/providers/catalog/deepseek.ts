import {
  OpenAICompatibleAdapter,
  type UsageCtx,
  type KeyUsageResult,
} from "../base";
import { WireKind } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

// DeepSeek — OpenAI-compatible API.
// Balance endpoint: GET https://platform.deepseek.com/api/user/balance
// Returns { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
// total_balance is a decimal string (e.g. "110.00").

const BALANCE_URL = "https://api.deepseek.com/user/balance";

interface BalanceInfo {
  currency?: string;
  total_balance?: string;
  granted_balance?: string;
  topped_up_balance?: string;
}

interface BalanceResp {
  is_available?: boolean;
  balance_infos?: BalanceInfo[];
}

class DeepSeekAdapter extends OpenAICompatibleAdapter {
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
      res = await ctx.request(BALANCE_URL, {
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
        message: `Balance query failed: ${(err as Error).message}`,
      };
    }

    if (!res.ok) {
      return {
        windows: [],
        unavailable: true,
        message: `Balance endpoint returned HTTP ${res.status}`,
      };
    }

    let data: BalanceResp;
    try {
      data = res.json() as BalanceResp;
    } catch {
      return {
        windows: [],
        unavailable: true,
        message: "Balance endpoint returned a non-JSON response.",
      };
    }

    const infos = data.balance_infos ?? [];
    if (!infos.length) {
      return {
        windows: [],
        unavailable: true,
        message: "No balance information returned.",
      };
    }

    const parts: string[] = [];
    for (const info of infos) {
      const total = parseFloat(info.total_balance ?? "");
      if (!Number.isFinite(total)) continue;
      const currency = info.currency ?? "USD";
      parts.push(`${total.toFixed(2)} ${currency} remaining`);
    }

    if (!parts.length) {
      return {
        windows: [],
        unavailable: true,
        message: "Could not parse balance data.",
      };
    }

    const available = data.is_available !== false;
    const balanceLine = parts.join(" · ");
    return {
      windows: [],
      message: available ? balanceLine : `${balanceLine} — insufficient for API calls`,
    };
  }
}

export const deepseek = new DeepSeekAdapter({
  id: "deepseek",
  label: "DeepSeek",
  blurb: "DeepSeek chat & reasoner models — OpenAI-compatible.",
  brand: "deepseek",
  docsUrl: "https://api-docs.deepseek.com/",
  defaults: {
    baseUrl: "https://api.deepseek.com",
    endpoints: [WireKind.Chat],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    { key: "name", label: "Name", placeholder: "deepseek", required: true },
    { key: "apiKeys", label: "API key", placeholder: "sk-…", required: true },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
