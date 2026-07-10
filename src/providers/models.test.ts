// Model-discovery tests for the adapter fetchModels() seam: the default does the
// GET itself and normalizes to the universal UpstreamModel[]; a bespoke adapter
// (example-custom) returns a rich, hand-built list. Plus the raw fetchModelList()
// primitive + normalizers. Global fetch is stubbed so no network is touched.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { adapterForProvider } from ".";
import { exampleCustom } from "./catalog/example-custom";
import {
  fetchModelList,
  modelIds,
  modelsFormatOf,
  normalizeModels,
  normalizeOpenAIModels,
  normalizeAnthropicModels,
  DEFAULT_ANTHROPIC_VERSION,
  type ModelsCtx,
} from "./base";
import type { Provider } from "../types";
import type { UpstreamModel } from "../formats/wire/models";

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

function ctx(p: Provider, over: Partial<ModelsCtx> = {}): ModelsCtx {
  const url = p.baseUrl + "/v1/models";
  return {
    provider: p,
    baseUrl: p.baseUrl,
    basePath: p.basePath,
    modelsPath: "/v1/models",
    resolve: () => url,
    url,
    headers: { authorization: "Bearer sk-secret" },
    apiKey: "sk-secret",
    format: "openai",
    ...over,
  };
}

// Swap global fetch for the duration of one test; record the call (url + headers)
// and reply with a canned JSON body.
const realFetch = globalThis.fetch;
let lastUrl = "";
let lastHeaders: Record<string, string> = {};
function stubFetch(status: number, body: unknown): void {
  lastUrl = "";
  lastHeaders = {};
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    lastUrl = String(url);
    lastHeaders = (init?.headers as Record<string, string>) ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: async () => body,
    } as Response;
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("default fetchModels does the GET and normalizes OpenAI → UpstreamModel[]", async () => {
  stubFetch(200, {
    object: "list",
    data: [{ id: "gpt-4o", object: "model", created: 1, owned_by: "openai" }],
  });
  const p = prov({ catalogId: "openai" });
  const res = await adapterForProvider(p).fetchModels(ctx(p));
  assert.equal(lastUrl, "https://api.example.com/v1/models");
  assert.equal(res.length, 1);
  assert.equal(res[0].id, "gpt-4o");
  // OpenAI dialect only yields id + created; richer fields stay undefined.
  assert.equal(res[0].created, new Date(1000).toISOString());
  assert.equal(res[0].contextWindow, undefined);
});

test("default fetchModels normalizes rich Anthropic → UpstreamModel[]", async () => {
  stubFetch(200, {
    data: [
      {
        id: "claude-x",
        type: "model",
        display_name: "Claude X",
        created_at: "2026-02-04T00:00:00Z",
        max_input_tokens: 1000000,
        max_tokens: 128000,
        capabilities: { thinking: { supported: true } },
      },
    ],
    has_more: false,
  });
  const p = prov({ format: "anthropic", catalogId: "anthropic" });
  const res = await adapterForProvider(p).fetchModels(
    ctx(p, { format: "anthropic" }),
  );
  // Anthropic dialect auto-sets the required version header.
  assert.equal(lastHeaders["anthropic-version"], "2023-06-01");
  assert.equal(res.length, 1);
  assert.deepEqual(
    { ...res[0], raw: undefined },
    {
      id: "claude-x",
      displayName: "Claude X",
      contextWindow: 1000000,
      maxOutputTokens: 128000,
      created: "2026-02-04T00:00:00Z",
      capabilities: { thinking: { supported: true } },
      raw: undefined,
    },
  );
});

test("default fetchModels throws on a non-2xx upstream", async () => {
  stubFetch(500, {});
  const p = prov({});
  await assert.rejects(() => adapterForProvider(p).fetchModels(ctx(p)), /500/);
});

test("example-custom fetchModels returns a rich, hand-built UpstreamModel[]", async () => {
  // No network — the example builds the list directly (headline use case).
  const p = prov({});
  const res = await exampleCustom.fetchModels(ctx(p));
  assert.deepEqual(
    res.map((m) => m.id),
    ["example-large", "example-fast", "example-mini"],
  );
  const large = res[0];
  assert.equal(large.displayName, "Example Large");
  assert.equal(large.contextWindow, 1_000_000);
  assert.equal(large.maxOutputTokens, 128_000);
  assert.equal(large.capabilities?.thinking.supported, true);
  // The minimal entry carries only an id — everything else blank.
  assert.equal(res[2].displayName, undefined);
  assert.equal(res[2].capabilities, undefined);
});

// --- standalone fetchModelList() primitive + QoL helpers --------------------

test("fetchModelList defaults to openai and does not set anthropic-version", async () => {
  stubFetch(200, { object: "list", data: [{ id: "m", object: "model" }] });
  const res = await fetchModelList({ url: "https://x/models" });
  assert.equal(res.format, "openai");
  assert.equal(lastHeaders["accept"], "application/json");
  assert.equal("anthropic-version" in lastHeaders, false);
});

test("fetchModelList adds anthropic-version for anthropic dialect", async () => {
  stubFetch(200, { data: [] });
  await fetchModelList({ url: "https://x/models", format: "anthropic" });
  assert.equal(lastHeaders["anthropic-version"], DEFAULT_ANTHROPIC_VERSION);
});

test("fetchModelList honors a caller-supplied version and casing", async () => {
  stubFetch(200, { data: [] });
  await fetchModelList({
    url: "https://x/models",
    format: "anthropic",
    headers: { "Anthropic-Version": "2099-01-01" },
  });
  // Caller's header wins; we don't add a duplicate lower-cased one.
  assert.equal(lastHeaders["Anthropic-Version"], "2099-01-01");
  assert.equal("anthropic-version" in lastHeaders, false);
});

test("fetchModelList anthropicVersion option overrides the default", async () => {
  stubFetch(200, { data: [] });
  await fetchModelList({
    url: "https://x/models",
    format: "anthropic",
    anthropicVersion: "2100-12-31",
  });
  assert.equal(lastHeaders["anthropic-version"], "2100-12-31");
});

test("modelIds de-dupes + sorts a universal list", () => {
  const list: UpstreamModel[] = [
    { id: "gpt-b" },
    { id: "gpt-a" },
    { id: "gpt-b" },
    { id: "" }, // skipped
  ];
  assert.deepEqual(modelIds(list), ["gpt-a", "gpt-b"]);
});

test("modelsFormatOf maps wire formats to the right dialect", () => {
  assert.equal(modelsFormatOf("messages"), "anthropic");
  assert.equal(modelsFormatOf("chat"), "openai");
  assert.equal(modelsFormatOf("responses"), "openai");
});

// --- normalizers: raw dialect → universal, with blank-field guards ----------

test("normalizeOpenAIModels keeps id + created, skips bad rows", () => {
  const out = normalizeOpenAIModels({
    object: "list",
    data: [
      { id: "a", object: "model", created: 2, owned_by: "o" },
      { id: "", object: "model", created: 0, owned_by: "o" }, // skipped (no id)
      { object: "model", created: 0, owned_by: "o" } as never, // skipped
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "a");
  assert.equal(out[0].created, new Date(2000).toISOString());
  assert.equal(out[0].displayName, undefined);
});

test("normalizeAnthropicModels drops zero/blank fields to undefined", () => {
  const out = normalizeAnthropicModels({
    data: [
      {
        id: "c",
        type: "model",
        display_name: "  ", // blank → undefined
        created_at: "",
        max_input_tokens: 0, // zero → undefined
        max_tokens: 64000,
      },
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].displayName, undefined);
  assert.equal(out[0].contextWindow, undefined);
  assert.equal(out[0].maxOutputTokens, 64000);
  assert.equal(out[0].created, undefined);
});

test("normalizeModels dispatches on the result tag", () => {
  const asOpenai = normalizeModels({
    format: "openai",
    list: {
      object: "list",
      data: [{ id: "x", object: "model", created: 0, owned_by: "o" }],
    },
  });
  assert.equal(asOpenai[0].id, "x");
  const asAnthropic = normalizeModels({
    format: "anthropic",
    list: {
      data: [{ id: "y", type: "model", display_name: "Y", created_at: "" }],
    },
  });
  assert.equal(asAnthropic[0].displayName, "Y");
});

test("fetchModelList uses an injected transport instead of global fetch", async () => {
  // Global fetch would throw if touched — proves the transport override is used.
  globalThis.fetch = (() => {
    throw new Error("global fetch must not be called");
  }) as unknown as typeof fetch;
  let seenUrl = "";
  let seenVersion = "";
  const res = await fetchModelList({
    url: "https://proxied/models",
    format: "anthropic",
    headers: { authorization: "Bearer k" },
    transport: async (url, init) => {
      seenUrl = url;
      seenVersion = init.headers["anthropic-version"] ?? "";
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ data: [{ id: "c", type: "model" }] }),
      };
    },
  });
  assert.equal(seenUrl, "https://proxied/models");
  assert.equal(seenVersion, DEFAULT_ANTHROPIC_VERSION); // auto-set reaches transport
  assert.equal(res.format, "anthropic");
  assert.equal(res.list.data[0].id, "c");
});
