// Path-layout tests: endpointPathFor / resolveKind / composeUrl (the kind-based
// routing helpers) + adapter.routeFor, proving Gemini-style basePath layouts
// compose correctly, per-kind overrides win, and the model-aware endpoint
// preference (OpenAI GPT-5 -> responses) steers the default.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  endpointPathFor,
  resolveKind,
  composeUrl,
  adapterForProvider,
} from ".";
import { WireKind, type Provider } from "../types";

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

// --- endpointPathFor: kind -> path -----------------------------------------

test("legacy provider (no basePath) yields full /v1 paths", () => {
  const p = prov({ basePath: "" });
  assert.equal(endpointPathFor(p, WireKind.Chat), "/v1/chat/completions");
  assert.equal(endpointPathFor(p, WireKind.Messages), "/v1/messages");
  assert.equal(endpointPathFor(p, WireKind.Responses), "/v1/responses");
});

test("basePath provider yields bare suffixes (Gemini/GLM layout)", () => {
  const p = prov({
    baseUrl: "https://generativelanguage.googleapis.com",
    basePath: "/v1beta/openai",
  });
  assert.equal(endpointPathFor(p, WireKind.Chat), "/chat/completions");
  assert.equal(
    composeUrl(p.baseUrl, p.basePath, endpointPathFor(p, WireKind.Chat)),
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  );
});

test("endpointPaths override wins over the standard path", () => {
  const p = prov({ endpointPaths: { chat: "/api/v2/chat" } });
  assert.equal(endpointPathFor(p, WireKind.Chat), "/api/v2/chat");
  // Other kinds still use the standard path.
  assert.equal(endpointPathFor(p, WireKind.Responses), "/v1/responses");
});

// --- resolveKind: which wire kind a hop routes through ----------------------

test("per-link endpoint (kind or legacy path) wins", () => {
  const p = prov({ endpoints: [WireKind.Chat] });
  assert.equal(resolveKind(p, "chat", "responses"), "responses");
  assert.equal(resolveKind(p, "chat", "/v1/messages"), "messages");
});

test("preferred kind is honored only when the provider accepts it", () => {
  const both = prov({ endpoints: [WireKind.Chat, WireKind.Responses] });
  assert.equal(resolveKind(both, "chat", null, "responses"), "responses");
  // Preferred not accepted -> falls through to endpoints[0].
  const chatOnly = prov({ endpoints: [WireKind.Chat] });
  assert.equal(resolveKind(chatOnly, "chat", null, "responses"), "chat");
});

test("endpoints[0] then native kind are the fallbacks", () => {
  assert.equal(
    resolveKind(prov({ endpoints: [WireKind.Responses] }), "chat", null),
    "responses",
  );
  assert.equal(
    resolveKind(prov({ endpoints: [] }), "messages", null),
    "messages",
  );
});

// --- adapter.routeFor -------------------------------------------------------

test("adapterForProvider picks native kind + assembled path", () => {
  const oai = prov({ catalogId: "openai" });
  const plan = adapterForProvider(oai).routeFor("messages", oai, null);
  assert.equal(plan.providerFmt, "chat");
  assert.ok(plan.forwardPath.endsWith("/chat/completions"));

  const gem = prov({
    catalogId: "google-gemini",
    basePath: "/v1beta/openai",
    endpoints: [WireKind.Chat],
  });
  const gplan = adapterForProvider(gem).routeFor("chat", gem, null);
  assert.equal(gplan.forwardPath, "/chat/completions");

  // Unknown catalogId falls back to generic anthropic/openai by which endpoint
  // kinds the provider accepts (messages => anthropic).
  const custom = prov({ catalogId: null, endpoints: [WireKind.Messages] });
  const cplan = adapterForProvider(custom).routeFor("messages", custom, null);
  assert.equal(cplan.providerFmt, "messages");
});

test("providerFmt follows the resolved endpoint, not the adapter class", () => {
  const oai = prov({ catalogId: "openai" });
  const asMessages = adapterForProvider(oai).routeFor(
    "chat",
    oai,
    "/v1/messages",
  );
  assert.equal(asMessages.providerFmt, "messages");
  assert.equal(asMessages.forwardPath, "/v1/messages");

  const resp = prov({ catalogId: "openai", endpoints: [WireKind.Responses] });
  const rplan = adapterForProvider(resp).routeFor("chat", resp, null);
  assert.equal(rplan.providerFmt, "responses");
  assert.equal(rplan.forwardPath, "/v1/responses");
});

// --- OpenAI model-aware endpoint preference ---------------------------------

test("OpenAI routes GPT-5 / codex to responses when accepted", () => {
  const oai = prov({
    catalogId: "openai",
    endpoints: [WireKind.Chat, WireKind.Responses],
  });
  const adapter = adapterForProvider(oai);
  // Newer families prefer responses...
  for (const model of ["gpt-5.5", "gpt-5-codex", "o3-mini", "gpt-image-2"]) {
    assert.equal(
      adapter.routeFor("chat", oai, null, model).providerFmt,
      "responses",
    );
  }
  // ...older/dual models stay on chat (the safe default).
  for (const model of ["gpt-4o", "gpt-4.1", "o1"]) {
    assert.equal(
      adapter.routeFor("chat", oai, null, model).providerFmt,
      "chat",
    );
  }
});

test("OpenAI preference is ignored when the provider only accepts chat", () => {
  const chatOnly = prov({ catalogId: "openai", endpoints: [WireKind.Chat] });
  assert.equal(
    adapterForProvider(chatOnly).routeFor("chat", chatOnly, null, "gpt-5.5")
      .providerFmt,
    "chat",
  );
});

test("a per-link endpoint pin overrides the model preference", () => {
  const oai = prov({
    catalogId: "openai",
    endpoints: [WireKind.Chat, WireKind.Responses],
  });
  // GPT-5 would prefer responses, but the hop pins chat.
  assert.equal(
    adapterForProvider(oai).routeFor(
      "chat",
      oai,
      "/v1/chat/completions",
      "gpt-5.5",
    ).providerFmt,
    "chat",
  );
});
