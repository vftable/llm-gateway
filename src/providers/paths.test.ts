// Path-layout tests: the adapter's resolveSuffix + a URL composition check that
// mirrors the engine's buildUpstreamUrl, proving Gemini-style basePath layouts
// compose correctly and legacy full-path providers are byte-identical.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSuffix, adapterForProvider } from ".";
import type { Provider } from "../types";

function prov(over: Partial<Provider>): Provider {
  return {
    id: "p",
    name: "p",
    baseUrl: "https://api.example.com",
    host: null,
    apiKeys: [],
    authScheme: "bearer",
    extraHeaders: {},
    retryAttempts: 1,
    retryIntervalMs: 0,
    requestTimeoutMs: 1000,
    tlsVerify: true,
    enabled: true,
    format: "openai",
    endpoints: [],
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

// Mirror of engine.buildUpstreamUrl (kept in sync; the engine version is the
// one that actually runs, this asserts the composition contract).
function compose(p: Provider, suffix: string): string {
  return p.baseUrl.replace(/\/+$/, "") + (p.basePath || "") + suffix;
}

test("legacy provider (no basePath) composes full /v1 path unchanged", () => {
  const p = prov({ format: "openai", basePath: "", endpoints: [] });
  const suffix = resolveSuffix(p, "chat", null);
  assert.equal(suffix, "/v1/chat/completions");
  assert.equal(compose(p, suffix), "https://api.example.com/v1/chat/completions");
});

test("anthropic legacy default is /v1/messages", () => {
  const p = prov({ format: "anthropic", basePath: "", endpoints: [] });
  assert.equal(resolveSuffix(p, "messages", null), "/v1/messages");
});

test("basePath provider composes origin + basePath + bare suffix (Gemini)", () => {
  const p = prov({
    baseUrl: "https://generativelanguage.googleapis.com",
    basePath: "/v1beta/openai",
    endpoints: ["/chat/completions"],
  });
  const suffix = resolveSuffix(p, "chat", null);
  assert.equal(suffix, "/chat/completions");
  assert.equal(
    compose(p, suffix),
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  );
});

test("explicit per-link endpoint wins over defaults", () => {
  const p = prov({ basePath: "/v1beta/openai", endpoints: ["/chat/completions"] });
  assert.equal(resolveSuffix(p, "chat", "/responses"), "/responses");
});

test("provider.endpoints[0] used when no link endpoint", () => {
  const p = prov({ endpoints: ["/v1/responses"] });
  assert.equal(resolveSuffix(p, "chat", null), "/v1/responses");
});

test("adapterForProvider picks native format + plan path", () => {
  // OpenAI-compatible: messages inbound bridges to the chat path.
  const oai = prov({ catalogId: "openai", format: "openai" });
  const plan = adapterForProvider(oai).planFor("messages", oai, null);
  assert.equal(plan.providerFmt, "chat");
  assert.ok(plan.forwardPath.endsWith("/chat/completions"));

  // Gemini: chat inbound stays chat, path is the bare suffix (basePath applied
  // at URL-compose time).
  const gem = prov({
    catalogId: "google-gemini",
    format: "openai",
    basePath: "/v1beta/openai",
    endpoints: ["/chat/completions"],
  });
  const gplan = adapterForProvider(gem).planFor("chat", gem, null);
  assert.equal(gplan.forwardPath, "/chat/completions");

  // Unknown catalogId falls back to a generic adapter by format.
  const custom = prov({ catalogId: null, format: "anthropic" });
  const cplan = adapterForProvider(custom).planFor("messages", custom, null);
  assert.equal(cplan.providerFmt, "messages");
});
