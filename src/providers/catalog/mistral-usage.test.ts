// Mistral key usage: GET /v1/billing/budget (x-api-key) answers STANDARD API
// keys with both budget halves - api_budget + vibe_budget, each carrying
// usage_percentage / initial_budget / currency / reset_at. Key metadata kind
// selects: kind=vibe -> Vibe window only; kind=api -> API window only;
// untagged -> both.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mistral } from "./mistral";
import type { UsageCtx, AdapterHttpResponse } from "../base";
import type { Provider } from "../../types";

const provider = {
  id: "mistral-test",
  name: "Mistral",
  catalogId: "mistral",
  baseUrl: "https://api.mistral.ai",
  basePath: "",
} as Provider;

// Builds a UsageCtx whose transport returns `resp` (or dispatches on the URL)
// and records every call's URL + auth headers for assertions.
function usageCtx(
  resp:
    | Partial<AdapterHttpResponse>
    | ((url: string) => Partial<AdapterHttpResponse>),
  over: Partial<UsageCtx> = {},
  seen?: { urls: string[]; headers?: Record<string, string> },
): UsageCtx {
  const base = (over.provider ?? provider) as Provider;
  return {
    provider: base,
    keyMetadata: {},
    apiKey: "sk-mistral-test",
    mask: "sk-…st",
    enabled: true,
    seed: 1,
    baseUrl: base.baseUrl,
    basePath: base.basePath ?? "",
    resolve: (t) =>
      base.baseUrl + (base.basePath ?? "") + (typeof t === "string" ? t : ""),
    request: async (
      url: string,
      init: { headers?: Record<string, string> },
    ) => {
      if (seen) {
        seen.urls.push(url);
        if (!seen.headers) seen.headers = {};
        Object.assign(seen.headers, init.headers);
      }
      const r = typeof resp === "function" ? resp(url) : resp;
      return {
        status: 200,
        ok: true,
        ms: 1,
        text: "",
        json: () => ({}),
        ...r,
      } as AdapterHttpResponse;
    },
    ...over,
  } as UsageCtx;
}

const json = (body: unknown): Partial<AdapterHttpResponse> => ({
  json: () => body,
});

// The budget payload used by these tests, matching the live shape.
const budgets = {
  vibe_budget: {
    usage_percentage: 4.0,
    initial_budget: 127.5,
    currency: "EUR",
    reset_at: "2026-12-01T00:00:00Z",
    payg_enabled: false,
  },
  api_budget: {
    usage_percentage: 80.0,
    initial_budget: 12.75,
    currency: "EUR",
    reset_at: "2026-12-01T00:00:00Z",
    payg_enabled: false,
  },
};

test("supportsKeyUsage is true", () => {
  assert.equal(mistral.supportsKeyUsage(usageCtx({})), true);
});

test("a disabled key is reported without querying", async () => {
  const seen = { urls: [] as string[] };
  const result = await mistral.keyUsage(
    usageCtx(json(budgets), { enabled: false }, seen),
  );
  assert.equal(result.unavailable, true);
  assert.deepEqual(seen.urls, []);
});

test("an untagged key shows both budget windows", async () => {
  const seen = { urls: [] as string[] };
  const result = await mistral.keyUsage(usageCtx(json(budgets), {}, seen));
  assert.deepEqual(seen.urls, ["https://api.mistral.ai/v1/billing/budget"]);
  assert.equal(result.unavailable, undefined);
  const [api, vibe] = result.windows;
  assert.deepEqual(
    { ...api, used: Math.round(api.used * 100) / 100 },
    {
      id: "mistral-api",
      label: "API usage (billing period) · EUR",
      used: 10.2, // 80% of 12.75
      limit: 12.75,
      unit: "dollars",
      resetsAt: "2026-12-01T00:00:00Z",
    },
  );
  assert.deepEqual(
    { ...vibe, used: Math.round(vibe.used * 100) / 100 },
    {
      id: "mistral-vibe",
      label: "Vibe usage (billing period) · EUR",
      used: 5.1, // 4% of 127.5
      limit: 127.5,
      unit: "dollars",
      resetsAt: "2026-12-01T00:00:00Z",
    },
  );
});

test("a kind=vibe key shows only the Vibe window", async () => {
  const result = await mistral.keyUsage(
    usageCtx(json(budgets), { keyMetadata: { kind: "vibe" } }),
  );
  assert.deepEqual(
    result.windows.map((w) => ({
      ...w,
      used: Math.round(w.used * 100) / 100,
    })),
    [
      {
        id: "mistral-vibe",
        label: "Vibe usage (billing period) · EUR",
        used: 5.1,
        limit: 127.5,
        unit: "dollars",
        resetsAt: "2026-12-01T00:00:00Z",
      },
    ],
  );
});

test("a kind=api key shows only the API window", async () => {
  const result = await mistral.keyUsage(
    usageCtx(json(budgets), { keyMetadata: { kind: "api" } }),
  );
  assert.deepEqual(
    result.windows.map((w) => w.id),
    ["mistral-api"],
  );
});

test("pay-as-you-go keys note it in the message", async () => {
  const result = await mistral.keyUsage(
    usageCtx(
      json({
        ...budgets,
        vibe_budget: { ...budgets.vibe_budget, payg_enabled: true },
      }),
      { keyMetadata: { kind: "vibe" } },
    ),
  );
  assert.equal(result.windows.length, 1);
  const [vibe] = result.windows;
  assert.match((vibe as { message?: string }).message ?? "", /pay-as-you-go/);
});

test("percentages above 100 clamp into the bar", async () => {
  const result = await mistral.keyUsage(
    usageCtx(
      json({
        ...budgets,
        api_budget: {
          ...budgets.api_budget,
          usage_percentage: 340,
        },
      }),
    ),
  );
  const api = result.windows[0];
  assert.equal(api.used, api.limit);
});

test("a rejected key (401) gets a clean unavailable state", async () => {
  const result = await mistral.keyUsage(usageCtx({ status: 401, ok: false }));
  assert.equal(result.unavailable, true);
  assert.deepEqual(result.windows, []);
  assert.match(result.message ?? "", /rejected/);
});

test("non-JSON budget responses degrade to unavailable", async () => {
  const result = await mistral.keyUsage(
    usageCtx({
      json: () => {
        throw new Error("bad json");
      },
    }),
  );
  assert.equal(result.unavailable, true);
});

test("requests use the x-api-key header, never a Bearer auth", async () => {
  const seen = { urls: [] as string[], headers: {} as Record<string, string> };
  await mistral.keyUsage(usageCtx(json(budgets), {}, seen));
  assert.deepEqual(seen.urls, ["https://api.mistral.ai/v1/billing/budget"]);
  assert.equal(seen.headers["x-api-key"], "sk-mistral-test");
  assert.equal(seen.headers.authorization, undefined);
});
