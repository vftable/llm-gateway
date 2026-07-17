import {
  OpenAICompatibleAdapter,
  type BuildCtx,
  type BuiltRequest,
} from "../base";
import type { UsageCtx, KeyUsageResult } from "../base/types";
import { WireKind } from "../../types";
import { fmtCompact } from "../../utils";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

// NewAPI — OpenAI-compatible provider with credit-based quota tracking.
//
// Quota units: the provider bills in credits where 1,000,000 credits = $1 by
// default. The `quotaPerDollar` quirk controls the conversion rate (exposed
// in keyUsage windows as a "credits" unit so the dashboard shows real spend).
//
// keyUsage() queries GET {baseUrl}/api/usage/token (Bearer auth) — the
// per-key token/credit balance endpoint. Response shape:
//   {
//     "code": true,
//     "data": {
//       "expires_at": 0,
//       "model_limits": {},
//       "model_limits_enabled": false,
//       "name": "testing",
//       "object": "token_usage",
//       "total_available": 1000000,
//       "total_granted": 1002076,
//       "total_used": 2076,
//       "unlimited_quota": false
//     },
//     "message": "ok"
//   }
// When `unlimited_quota` is true, `total_available` is meaningless (reads 0
// even though the key isn't actually capped) — see the `limit` comment below.
//
// `expires_at` is when the TOKEN ITSELF becomes invalid (a credential
// lifetime), not a usage-window reset — NewAPI credits are a one-time grant
// with no rolling refill, so the window carries no `resetsAt` and the key's
// `expiresAt` is reported separately instead.

const DEFAULT_QUOTA_PER_DOLLAR = 1_000_000;

function readQuota(provider: {
  providerConfig?: Record<string, unknown>;
}): number {
  const v = provider.providerConfig?.quotaPerDollar;
  return typeof v === "number" && v > 0 ? v : DEFAULT_QUOTA_PER_DOLLAR;
}

interface NewApiTokenUsage {
  expires_at?: number;
  name?: string;
  object?: string;
  total_available?: number;
  total_granted?: number;
  total_used?: number;
  unlimited_quota?: boolean;
}

interface NewApiTokenUsageResponse {
  code?: boolean;
  data?: NewApiTokenUsage;
  message?: string;
}

class NewApiAdapter extends OpenAICompatibleAdapter {
  chatCompletions(ctx: BuildCtx): BuiltRequest {
    return super.chatCompletions(ctx);
  }

  responses(ctx: BuildCtx): BuiltRequest {
    return super.responses(ctx);
  }

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
      res = await ctx.request(ctx.resolve("/api/usage/token"), {
        method: "GET",
        headers: { authorization: `Bearer ${ctx.apiKey}` },
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
        message: `Usage endpoint returned status ${res.status}`,
      };
    }

    let parsed: NewApiTokenUsageResponse;
    try {
      parsed = res.json() as NewApiTokenUsageResponse;
    } catch {
      return {
        windows: [],
        unavailable: true,
        message: "Usage endpoint returned a non-JSON response.",
      };
    }

    if (!parsed.code || !parsed.data) {
      return {
        windows: [],
        unavailable: true,
        message: parsed.message || "Usage endpoint reported an error.",
      };
    }

    const d = parsed.data;
    const rate = readQuota(ctx.provider);
    const used = d.total_used ?? 0;
    const unlimited = d.unlimited_quota === true;
    // total_available reads 0 on an unlimited key (it isn't tracking a real
    // ceiling), not an actual 0-remaining cap. Infinity isn't JSON-safe
    // (serializes to null over the wire), so use a large finite sentinel —
    // the "(unlimited)" label carries the real meaning; the bar just needs
    // to stay visually near-empty.
    const limit = unlimited
      ? Math.max(used * 10, 1_000_000_000)
      : (d.total_available ?? 0) + used;

    return {
      windows: [
        {
          id: "token-credits",
          label: `Credits${unlimited ? " (unlimited)" : ` (${fmtCompact(rate)}/$1)`}`,
          used,
          limit,
          unit: "credits",
          // No `resetsAt` — a NewAPI credit grant is a one-time balance, not
          // a rolling window that refills. `expires_at` (below) is when the
          // TOKEN ITSELF stops working, not when usage resets.
        },
      ],
      // expires_at is a Unix-seconds timestamp; 0 means "no expiry set".
      ...(d.expires_at && d.expires_at > 0
        ? { expiresAt: new Date(d.expires_at * 1000).toISOString() }
        : {}),
    };
  }
}

export const newapi = new NewApiAdapter({
  id: "newapi",
  label: "NewAPI",
  blurb:
    "OpenAI-compatible provider with credit-based billing (1M credits = $1 default).",
  brand: "newapi",
  defaults: {
    endpoints: [WireKind.Chat, WireKind.Messages, WireKind.Responses],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    { key: "name", label: "Name", placeholder: "newapi", required: true },
    {
      key: "baseUrl",
      label: "Base URL",
      placeholder: "https://api.newapi.example",
      required: true,
      editable: true,
      hint: "Origin — the gateway appends /v1/chat/completions.",
    },
    {
      key: "apiKeys",
      label: "API key",
      required: true,
      hint: "One per line — rotated round-robin.",
    },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
