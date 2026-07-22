import {
  OpenAICompatibleAdapter,
  type UsageCtx,
  type KeyUsageResult,
} from "../base"
import { WireKind } from "../../types"
import type { ProviderKeyUsageWindow } from "../../types"
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai"

// MiniMax — OpenAI-compatible API at https://api.minimax.io/v1
//
// Auth: Authorization: Bearer <api-key>
// Endpoint: POST /v1/chat/completions (standard OpenAI format)
//
// Quota endpoints (tried in order, first 200 wins):
//   1. GET https://www.minimax.io/v1/token_plan/remains
//      Count fields = USED counts (subtract to get remaining)
//   2. GET https://api.minimax.io/v1/api/openplatform/coding_plan/remains
//      Count fields = REMAINING counts
// Both return { base_resp: { status_code, status_msg }, model_remains: [...] }
// Each model entry carries:
//   model_name / modelName
//   current_interval_{total,usage}_count  — 5h window
//   current_interval_remaining_percent    — 5h % remaining (0–100)
//   remains_time                          — ms until 5h resets
//   current_weekly_{total,usage}_count    — 7d window
//   current_weekly_remaining_percent      — 7d % remaining
//   weekly_remains_time                   — ms until 7d resets
// The M-series aggregate bucket is named "MiniMax-M*" or "general" —
// both are normalised to "M-series" in the UI.

const QUOTA_URLS = [
  { url: "https://www.minimax.io/v1/token_plan/remains", countMeansRemaining: false },
  { url: "https://api.minimax.io/v1/api/openplatform/coding_plan/remains", countMeansRemaining: true },
]

interface MiniMaxModelRemain {
  model_name?: string
  modelName?: string
  current_interval_total_count?: number
  currentIntervalTotalCount?: number
  current_interval_usage_count?: number
  currentIntervalUsageCount?: number
  current_interval_remaining_percent?: number
  currentIntervalRemainingPercent?: number
  remains_time?: number
  remainsTime?: number
  current_weekly_total_count?: number
  currentWeeklyTotalCount?: number
  current_weekly_usage_count?: number
  currentWeeklyUsageCount?: number
  current_weekly_remaining_percent?: number
  currentWeeklyRemainingPercent?: number
  weekly_remains_time?: number
  weeklyRemainsTime?: number
}

interface MiniMaxRemainsResponse {
  base_resp?: { status_code?: number; status_msg?: string }
  baseResp?: { status_code?: number; status_msg?: string }
  model_remains?: MiniMaxModelRemain[]
  modelRemains?: MiniMaxModelRemain[]
}

function getField<T>(m: MiniMaxModelRemain, snake: keyof MiniMaxModelRemain, camel: keyof MiniMaxModelRemain): T | undefined {
  return (m[snake] ?? m[camel]) as T | undefined
}

function modelDisplayName(m: MiniMaxModelRemain): string {
  const raw = String(getField<string>(m, "model_name", "modelName") ?? "").trim()
  if (!raw || raw === "MiniMax-M*" || raw === "general") return "M-series"
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function hasQuota(m: MiniMaxModelRemain): boolean {
  const intervalTotal = Number(getField(m, "current_interval_total_count", "currentIntervalTotalCount")) || 0
  const weeklyTotal = Number(getField(m, "current_weekly_total_count", "currentWeeklyTotalCount")) || 0
  const intervalPct = getField<number>(m, "current_interval_remaining_percent", "currentIntervalRemainingPercent")
  const weeklyPct = getField<number>(m, "current_weekly_remaining_percent", "currentWeeklyRemainingPercent")
  return intervalTotal > 0 || weeklyTotal > 0 || intervalPct != null || weeklyPct != null
}

function makeWindow(
  id: string,
  label: string,
  total: number,
  count: number,
  pctRemaining: number | undefined,
  remainsMs: number | undefined,
  countMeansRemaining: boolean,
): ProviderKeyUsageWindow {
  const resetsAt = remainsMs != null && remainsMs > 0
    ? new Date(Date.now() + remainsMs).toISOString()
    : undefined

  // Normalise to a used/limit pair.
  // token_plan: count = used;  coding_plan: count = remaining → used = total - count
  let used: number
  let limit: number

  if (total > 0) {
    const effectiveUsed = countMeansRemaining
      ? Math.max(0, total - count)
      : Math.min(count, total)
    used = effectiveUsed
    limit = total
  } else if (pctRemaining != null) {
    // Percent-only bucket (M-series aggregate, total = 0)
    used = Math.round(100 - pctRemaining)
    limit = 100
  } else {
    return { id, label, used: 0, limit: 100, unit: "percent", ...(resetsAt ? { resetsAt } : {}) }
  }

  const w: ProviderKeyUsageWindow = { id, label, used, limit, unit: total > 0 ? "credits" : "percent" }
  if (resetsAt) w.resetsAt = resetsAt
  return w
}

class MiniMaxAdapter extends OpenAICompatibleAdapter {
  supportsKeyUsage(_ctx: UsageCtx): boolean {
    return true
  }

  async keyUsage(ctx: UsageCtx): Promise<KeyUsageResult> {
    if (!ctx.enabled) {
      return { windows: [], unavailable: true, message: "Key disabled — usage not queried." }
    }

    let lastMsg = "Unable to fetch MiniMax quota."

    for (const { url, countMeansRemaining } of QUOTA_URLS) {
      let res
      try {
        res = await ctx.request(url, {
          method: "GET",
          headers: { authorization: `Bearer ${ctx.apiKey}`, accept: "application/json" },
          signal: ctx.signal,
        })
      } catch (err) {
        lastMsg = `Usage query failed: ${(err as Error).message}`
        continue
      }

      // 404/405/5xx on this endpoint → try the next URL
      if (res.status === 404 || res.status === 405 || res.status >= 500) {
        lastMsg = `Usage endpoint returned HTTP ${res.status}`
        continue
      }

      if (!res.ok) {
        return { windows: [], unavailable: true, message: `Usage endpoint returned HTTP ${res.status}` }
      }

      let data: MiniMaxRemainsResponse
      try {
        data = res.json() as MiniMaxRemainsResponse
      } catch {
        return { windows: [], unavailable: true, message: "Usage endpoint returned non-JSON." }
      }

      const baseResp = data.base_resp ?? data.baseResp
      const apiCode = Number(baseResp?.status_code ?? 0)
      if (apiCode !== 0) {
        const msg = String(baseResp?.status_msg ?? `API status ${apiCode}`)
        return { windows: [], unavailable: true, message: `MiniMax quota API error: ${msg}` }
      }

      const allRemains = (data.model_remains ?? data.modelRemains ?? []) as MiniMaxModelRemain[]
      const models = allRemains.filter(hasQuota)

      if (!models.length) {
        return { windows: [], unavailable: true, message: "No quota data returned." }
      }

      const windows: ProviderKeyUsageWindow[] = []

      for (const m of models) {
        const name = modelDisplayName(m)
        const intervalTotal = Number(getField(m, "current_interval_total_count", "currentIntervalTotalCount")) || 0
        const intervalCount = Number(getField(m, "current_interval_usage_count", "currentIntervalUsageCount")) || 0
        const intervalPct = getField<number>(m, "current_interval_remaining_percent", "currentIntervalRemainingPercent")
        const intervalRemainsMs = Number(getField(m, "remains_time", "remainsTime")) || undefined

        const weeklyTotal = Number(getField(m, "current_weekly_total_count", "currentWeeklyTotalCount")) || 0
        const weeklyCount = Number(getField(m, "current_weekly_usage_count", "currentWeeklyUsageCount")) || 0
        const weeklyPct = getField<number>(m, "current_weekly_remaining_percent", "currentWeeklyRemainingPercent")
        const weeklyRemainsMs = Number(getField(m, "weekly_remains_time", "weeklyRemainsTime")) || undefined

        if (intervalTotal > 0 || intervalPct != null) {
          windows.push(makeWindow(`${name}-5h`, `${name} (5h)`, intervalTotal, intervalCount, intervalPct, intervalRemainsMs, countMeansRemaining))
        }
        if (weeklyTotal > 0 || weeklyPct != null) {
          windows.push(makeWindow(`${name}-7d`, `${name} (7d)`, weeklyTotal, weeklyCount, weeklyPct, weeklyRemainsMs, countMeansRemaining))
        }
      }

      if (!windows.length) {
        return { windows: [], unavailable: true, message: "Could not build quota windows from MiniMax response." }
      }

      return { windows }
    }

    return { windows: [], unavailable: true, message: lastMsg }
  }
}

export const minimax = new MiniMaxAdapter({
  id: "minimax",
  label: "MiniMax",
  blurb: "MiniMax M-series via OpenAI-compatible API. Subscription key required (not the pay-as-you-go key).",
  brand: "minimax",
  docsUrl: "https://platform.minimax.io/docs/api-reference/text-chat-openai",
  defaults: {
    baseUrl: "https://api.minimax.io",
    basePath: "/v1",
    modelsPath: "/models",
    endpoints: [WireKind.Chat],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    {
      key: "name",
      label: "Name",
      placeholder: "minimax",
      required: true,
    },
    {
      key: "apiKeys",
      label: "Subscription key",
      required: true,
      hint: "Token Plan subscription key from MiniMax Billing (not the pay-as-you-go API key).",
    },
    {
      key: "baseUrl",
      label: "Base URL",
      editable: true,
      hint: "Default: https://api.minimax.io",
    },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
})
