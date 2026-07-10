// Provider usage-reporting tests: the adapter's default keyUsage() returns
// deterministic placeholder windows (5h + weekly), so the dashboard renders
// stable bars and never leaks a raw key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dummyUsageWindows } from "./base";
import { adapterForProvider } from ".";
import type { Provider } from "../types";
import type { UsageCtx } from "./base";

// Fills in the request/resolve primitives every UsageCtx needs (a test that
// only exercises the default keyUsage()/supportsKeyUsage() never calls them).
function usageCtx(
  p: Provider,
  fields: Pick<UsageCtx, "apiKey" | "mask" | "enabled" | "seed">,
): UsageCtx {
  return {
    provider: p,
    baseUrl: p.baseUrl,
    basePath: p.basePath || "",
    resolve: (target) => p.baseUrl + (typeof target === "string" ? target : ""),
    request: () => {
      throw new Error("not implemented in test");
    },
    ...fields,
  };
}

function prov(over: Partial<Provider>): Provider {
  return {
    id: "p",
    name: "p",
    baseUrl: "https://api.example.com",
    host: null,
    apiKeys: [],
    disabledApiKeys: [],
    authScheme: "bearer",
    extraHeaders: {},
    retryAttempts: 1,
    retryIntervalMs: 0,
    requestTimeoutMs: 1000,
    tlsVerify: true,
    enabled: true,
    format: "openai",
    endpoints: [],
    endpointPaths: {},
    nativeConversion: false,
    catalogId: null,
    basePath: "",
    modelsPath: "/v1/models",
    proxy: null,
    country: null,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

// resetsAt is relative to Date.now(), so compare only the deterministic fields.
const stable = (w: { id: string; used: number; limit: number }) => ({
  id: w.id,
  used: w.used,
  limit: w.limit,
});

test("dummyUsageWindows is deterministic and covers token + request units", () => {
  const a = dummyUsageWindows(12345);
  const b = dummyUsageWindows(12345);
  assert.deepEqual(a.map(stable), b.map(stable));
  assert.deepEqual(
    a.map((w) => w.id),
    ["5h", "weekly", "daily-requests"],
  );
  // Both a token-limit and a request-limit window are present.
  assert.ok(a.some((w) => w.unit === "tokens"));
  assert.ok(a.some((w) => w.unit === "requests"));
  for (const w of a) {
    assert.ok(w.used >= 0 && w.used <= w.limit, "used within limit");
    assert.ok(w.limit > 0);
    assert.ok(!Number.isNaN(Date.parse(w.resetsAt)), "resetsAt is a date");
  }
});

test("different seeds produce different usage", () => {
  const a = dummyUsageWindows(1);
  const b = dummyUsageWindows(2);
  assert.notDeepEqual(a.map(stable), b.map(stable));
});

test("adapter.supportsKeyUsage default is false (provider hidden from dashboard)", () => {
  // A stock provider with no real usage endpoint opts OUT of the dashboard, so
  // the route omits it rather than rendering a card of empty keys.
  const p = prov({ catalogId: "openai" });
  const adapter = adapterForProvider(p);
  const ctx = usageCtx(p, {
    apiKey: "sk-secret",
    mask: "sk-…abcd",
    enabled: true,
    seed: 42,
  });
  assert.equal(adapter.supportsKeyUsage(ctx), false);
});

test("adapter.keyUsage default is unavailable, not dummy (async)", async () => {
  // A provider with no real usage endpoint reports `unavailable` (dummy is false
  // by default) rather than fabricating estimate bars.
  const p = prov({ catalogId: "openai" });
  const adapter = adapterForProvider(p);
  const res = await adapter.keyUsage(
    usageCtx(p, {
      apiKey: "sk-secret",
      mask: "sk-…abcd",
      enabled: true,
      seed: 42,
    }),
  );
  assert.equal(res.dummy ?? false, false);
  assert.equal(res.unavailable, true);
  assert.equal(res.windows.length, 0);
  assert.ok(typeof res.message === "string" && res.message.length > 0);
});
