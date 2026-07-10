// Builder-seam + family-default-transform tests.
//   - a bespoke subclass builds a fully custom request (url + headers + body)
//   - the default builder forwards the composed request verbatim
//   - baseUrl / formats getters reflect the template
//   - routeFor derives providerFmt from the resolved suffix
//   - familyDefaultTransforms / defaultTransformsForCatalog read quirks
//   - mergeTransforms layers family defaults UNDER a model's own (id,phase wins)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OpenAICompatibleAdapter,
  type BuildCtx,
  type BuiltRequest,
} from "./base";
import {
  familyDefaultTransforms,
  defaultTransformsForCatalog,
} from "./registry";
import { mergeTransforms } from "../formats/transforms";
import type { Provider } from "../types";

const provider = (over: Partial<Provider> = {}): Provider =>
  ({
    id: "p",
    catalogId: "openai",
    format: "openai",
    nativeConversion: false,
    endpoints: [],
    basePath: "",
    baseUrl: "https://api.example.com",
    ...over,
  }) as unknown as Provider;

// The default header set the engine would compose (auth already applied).
const buildCtx = (over: Partial<BuildCtx> = {}): BuildCtx => ({
  provider: provider(),
  model: "gpt-x",
  body: { messages: [{ role: "user", content: "hi" }] },
  apiKey: "sk-test",
  clientFmt: "chat",
  providerFmt: "chat",
  endpointKind: "chat",
  forwardPath: "/v1/chat/completions",
  baseUrl: "https://api.example.com",
  basePath: "",
  resolve: (t) =>
    typeof t === "string" && t.startsWith("/")
      ? "https://api.example.com" + t
      : "https://api.example.com/v1/chat/completions",
  url: "https://api.example.com/v1/chat/completions",
  headers: {
    authorization: "Bearer sk-test",
    "content-type": "application/json",
  },
  ...over,
});

// A bespoke provider that fully rewrites the request in its build method: a
// signed URL, a custom auth header (dropping the default), and a body envelope.
class BespokeAdapter extends OpenAICompatibleAdapter {
  chatCompletions(ctx: BuildCtx): BuiltRequest {
    const { authorization, ...rest } = ctx.headers;
    void authorization; // dropped in favor of x-signature
    return {
      url: `https://edge.example.com/sign?model=${ctx.model}&k=${ctx.apiKey}`,
      headers: { ...rest, "x-signature": `sig-${ctx.apiKey}` },
      body: { envelope: { model: ctx.model, payload: ctx.body } },
    };
  }
}

const bespoke = new BespokeAdapter({
  id: "bespoke",
  label: "Bespoke",
  blurb: "test",
  brand: "openai",
  defaults: { format: "openai", endpoints: ["chat"] },
  fields: [],
});

test("builder seam: a subclass builds a custom url + headers + body", () => {
  const built = bespoke.buildFor("chat", buildCtx());
  assert.equal(
    built.url,
    "https://edge.example.com/sign?model=gpt-x&k=sk-test",
  );
  assert.equal(built.headers["x-signature"], "sig-sk-test");
  assert.equal(built.headers["authorization"], undefined); // dropped
  assert.deepEqual(built.body, {
    envelope: {
      model: "gpt-x",
      payload: { messages: [{ role: "user", content: "hi" }] },
    },
  });
});

test("default builder forwards the composed request verbatim", () => {
  const oai = new OpenAICompatibleAdapter({
    id: "plain",
    label: "Plain",
    blurb: "t",
    brand: "openai",
    defaults: { format: "openai", endpoints: ["chat"] },
    fields: [],
  });
  const ctx = buildCtx();
  const built = oai.buildFor("chat", ctx);
  assert.equal(built.url, ctx.url);
  assert.deepEqual(built.headers, ctx.headers);
  assert.strictEqual(built.body, ctx.body); // same object, untouched
});

test("baseUrl + formats getters reflect the template", () => {
  const oai = new OpenAICompatibleAdapter({
    id: "g",
    label: "G",
    blurb: "t",
    brand: "openai",
    defaults: {
      baseUrl: "https://api.example.com",
      format: "openai",
      endpoints: ["chat", "responses"],
    },
    fields: [],
  });
  assert.equal(oai.baseUrl, "https://api.example.com");
  // native chat + declared responses endpoint.
  assert.deepEqual([...oai.formats].sort(), ["chat", "responses"]);
});

test("routeFor derives providerFmt from the resolved endpoint", () => {
  const oai = new OpenAICompatibleAdapter({
    id: "plain2",
    label: "P",
    blurb: "t",
    brand: "openai",
    defaults: { format: "openai", endpoints: [] },
    fields: [],
  });
  assert.equal(
    oai.routeFor("chat", provider(), "/v1/messages").providerFmt,
    "messages",
  );
  assert.equal(
    oai.routeFor("chat", provider(), "/v1/responses").providerFmt,
    "responses",
  );
  assert.equal(oai.routeFor("chat", provider(), null).providerFmt, "chat");
});

// --- family default transforms ---------------------------------------------

test("familyDefaultTransforms reads the catalog adapter's quirks", () => {
  // anthropic ships a sanitize-tool-args response default.
  const anth = provider({ catalogId: "anthropic", format: "anthropic" });
  const defs = familyDefaultTransforms(anth);
  assert.ok(
    defs.some((d) => d.id === "sanitize-tool-args" && d.phase === "response"),
  );
  // openai ships none.
  assert.deepEqual(
    familyDefaultTransforms(provider({ catalogId: "openai" })),
    [],
  );
});

test("defaultTransformsForCatalog resolves by id", () => {
  assert.ok(
    defaultTransformsForCatalog("anthropic").some(
      (d) => d.id === "sanitize-tool-args",
    ),
  );
  assert.deepEqual(defaultTransformsForCatalog(null), []);
  assert.deepEqual(defaultTransformsForCatalog("nope"), []);
});

test("every Anthropic-native catalog adapter inherits the SAME family default stack", () => {
  // anthropic.ts, anthropic-subscription.ts, and the generic anthropic-compatible.ts
  // all declare quirks.defaultTransforms = ANTHROPIC_DEFAULT_TRANSFORMS (see that
  // constant's doc comment in catalog/anthropic-compatible.ts) — a new family-wide
  // default only needs to be added in ONE place and every one of these three
  // picks it up automatically. Asserts both the CONTENT (every family member
  // gets prompt caching + tool-arg sanitize) and the IDENTITY (literally the
  // same array reference, not three independently-duplicated copies that could
  // drift out of sync).
  const anthropic = defaultTransformsForCatalog("anthropic");
  const compatible = defaultTransformsForCatalog("anthropic-compatible");
  const subscription = defaultTransformsForCatalog("anthropic-subscription");

  assert.equal(anthropic, compatible);
  assert.equal(anthropic, subscription);

  for (const defs of [anthropic, compatible, subscription]) {
    assert.ok(
      defs.some((d) => d.id === "anthropic-cache" && d.phase === "request"),
      "expected anthropic-cache as a request default",
    );
    assert.ok(
      defs.some((d) => d.id === "sanitize-tool-args" && d.phase === "response"),
      "expected sanitize-tool-args as a response default",
    );
  }

  // OpenAI-native adapters are NOT part of this family — unaffected.
  assert.deepEqual(defaultTransformsForCatalog("openai"), []);
  assert.deepEqual(defaultTransformsForCatalog("openai-compatible"), []);
});

test("mergeTransforms: defaults are the base, model entries override by id+phase", () => {
  const defaults = [
    { id: "sanitize-tool-args", phase: "response" as const, params: {} },
    { id: "anthropic-cache", phase: "request" as const, params: { ttl: "5m" } },
  ];
  const own = [
    // overrides the cache default (same id+phase) with a different ttl
    { id: "anthropic-cache", phase: "request" as const, params: { ttl: "1h" } },
    { id: "system-prepend", phase: "request" as const, params: { text: "hi" } },
  ];
  const merged = mergeTransforms(defaults, own);
  // sanitize-tool-args (default, not overridden) stays as base; the cache entry
  // is the model's (1h), not the default (5m); order = surviving defaults, then own.
  assert.deepEqual(merged, [
    { id: "sanitize-tool-args", phase: "response", params: {} },
    { id: "anthropic-cache", phase: "request", params: { ttl: "1h" } },
    { id: "system-prepend", phase: "request", params: { text: "hi" } },
  ]);
});

test("mergeTransforms with no model config returns the defaults as-is", () => {
  const defaults = [
    { id: "sanitize-tool-args", phase: "response" as const, params: {} },
  ];
  assert.deepEqual(mergeTransforms(defaults, []), defaults);
  assert.deepEqual(mergeTransforms(defaults, undefined), defaults);
});
