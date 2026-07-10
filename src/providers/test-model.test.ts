// probeEndpoint()/testModel() seam tests — verifies the contract this session
// added: a testModel() override hands probeEndpoint() a body TYPED to the wire
// kind's own request schema, and probeEndpoint() runs it through the FULL
// live-request stack for that kind — builtin defaults -> family defaults
// (minus anything ctx.ownTransforms overrides) -> THIS adapter's own
// requestTransforms() -> ctx.ownTransforms -> THIS adapter's own build method
// (chatCompletions/messages/responses — never sending anything itself) ->
// ctx.request() -> the same full stack's response side (success only).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OpenAICompatibleAdapter,
  AnthropicCompatibleAdapter,
  minimalProbeBody,
  composeUrl,
  endpointPathFor,
  type TestModelCtx,
  type TestModelResult,
  type BuildCtx,
  type BuiltRequest,
  type AdapterHttpResponse,
} from "./base";
import {
  onRequest,
  onResponse,
  type AnyRequestTransform,
  type AnyResponseTransform,
} from "../formats/pipeline";
import { WireKind, type Provider } from "../types";
import type { ChatCompletionRequest } from "../formats/wire";

const provider = (): Provider =>
  ({
    id: "p",
    catalogId: "custom",
    format: "openai",
    nativeConversion: false,
    endpoints: [],
    basePath: "",
    baseUrl: "https://api.example.com",
  }) as unknown as Provider;

// A fake ctx.request() that records what it was sent and returns a canned
// response — lets a test assert on the EXACT built request without a network
// call, and control the upstream reply to exercise success/failure paths.
function fakeCtx(
  overProbe: Partial<TestModelCtx> = {},
  reply: Partial<AdapterHttpResponse> & { json: () => unknown },
): { ctx: TestModelCtx; calls: Array<{ url: string; init: unknown }> } {
  const calls: Array<{ url: string; init: unknown }> = [];
  const p = provider();
  const ctx: TestModelCtx = {
    provider: p,
    model: "upstream-model",
    baseUrl: p.baseUrl,
    basePath: "",
    // Same disambiguation as the production resolve() (routes.ts makeTestModelCtx
    // / engine.ts makeResolve): a WireKind is one of the three literal kind
    // strings; anything else is a literal path segment.
    resolve: (target) =>
      composeUrl(
        p.baseUrl,
        "",
        target === undefined
          ? ""
          : target === "chat" || target === "messages" || target === "responses"
            ? endpointPathFor(p, target)
            : target,
      ),
    url: p.baseUrl,
    headers: { authorization: "Bearer sk-test" },
    apiKey: "sk-test",
    request: async (url, init) => {
      calls.push({ url, init });
      return {
        status: 200,
        ok: true,
        ms: 5,
        text: "",
        ...reply,
      };
    },
    ...overProbe,
  };
  return { ctx, calls };
}

// A bespoke adapter exercising ALL FOUR probeEndpoint steps: a custom
// chatCompletions() build (so we can prove the REAL build method ran, not a
// verbatim forward), plus request + response transforms (so we can prove they
// run on the probe path exactly like a live request).
class InstrumentedAdapter extends OpenAICompatibleAdapter {
  chatCompletions(ctx: BuildCtx): BuiltRequest {
    // Rewrite the URL and stamp a header so the test can prove THIS method ran
    // (not the verbatim default).
    return {
      url: `${ctx.url}?probe=1`,
      headers: { ...ctx.headers, "x-built-by": "chatCompletions" },
      body: ctx.body,
    };
  }

  requestTransforms(): AnyRequestTransform[] {
    return [
      onRequest("chat", "stamp-request", (body) => {
        (body as Record<string, unknown>).stamped = "request";
        return body;
      }),
    ];
  }

  responseTransforms(): AnyResponseTransform[] {
    return [
      onResponse("chat", "stamp-response", (body) => {
        (body as Record<string, unknown>).stamped = "response";
        return body;
      }),
    ];
  }

  async testModel(ctx: TestModelCtx): Promise<TestModelResult> {
    const body: ChatCompletionRequest = minimalProbeBody(
      WireKind.Chat,
      ctx.model,
    );
    return this.probeEndpoint(ctx, WireKind.Chat, { body });
  }

  // probeEndpoint() is `protected` (adapter-internal API); this thin public
  // wrapper is test-only, so the "summarize" test can exercise it directly.
  callProbeEndpoint(
    ctx: TestModelCtx,
    opts: {
      body: ChatCompletionRequest;
      summarize: (json: unknown) => unknown;
    },
  ): Promise<TestModelResult> {
    return this.probeEndpoint(ctx, WireKind.Chat, opts);
  }
}

const adapter = () =>
  new InstrumentedAdapter({
    id: "instrumented",
    label: "Instrumented",
    blurb: "test",
    brand: "openai",
    defaults: { format: "openai", endpoints: ["chat"] },
    fields: [],
  });

test("probeEndpoint: request transforms run before the build method", async () => {
  const { ctx, calls } = fakeCtx({}, { json: () => ({ ok: true }) });
  await adapter().testModel(ctx);
  const sentBody = (calls[0].init as { body: Record<string, unknown> }).body;
  assert.equal(sentBody.stamped, "request");
});

test("probeEndpoint: the adapter's OWN build method shapes the request (not a verbatim forward)", async () => {
  const { ctx, calls } = fakeCtx({}, { json: () => ({ ok: true }) });
  await adapter().testModel(ctx);
  assert.equal(
    calls[0].url,
    "https://api.example.com/v1/chat/completions?probe=1",
  );
  const sentHeaders = (calls[0].init as { headers: Record<string, string> })
    .headers;
  assert.equal(sentHeaders["x-built-by"], "chatCompletions");
});

test("probeEndpoint: response transforms run on a successful reply", async () => {
  const { ctx } = fakeCtx(
    {},
    { json: () => ({ choices: [{ message: { content: "hi" } }] }) },
  );
  const result = await adapter().testModel(ctx);
  assert.equal(result.ok, true);
  assert.equal((result.data as Record<string, unknown>).stamped, "response");
});

test("probeEndpoint: on failure, the upstream error body is returned untouched (no response transforms)", async () => {
  const { ctx } = fakeCtx(
    {},
    {
      status: 400,
      ok: false,
      json: () => ({ error: { message: "bad request" } }),
    },
  );
  const result = await adapter().testModel(ctx);
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.deepEqual(result.data, { error: { message: "bad request" } });
});

test("probeEndpoint: summarize distills a successful response", async () => {
  const { ctx } = fakeCtx(
    {},
    { json: () => ({ choices: [{ message: { content: "hi" } }] }) },
  );
  const result = await adapter().callProbeEndpoint(ctx, {
    body: minimalProbeBody(WireKind.Chat, ctx.model),
    summarize: (json) => ({
      reply: (json as { choices: { message: { content: string } }[] })
        .choices[0].message.content,
    }),
  });
  assert.deepEqual(result.data, { reply: "hi" });
});

test("probeEndpoint: ctx.logStage (when set) traces the declared plan and each stage's application", async () => {
  const { ctx } = fakeCtx(
    {},
    { json: () => ({ choices: [{ message: { content: "hi" } }] }) },
  );
  const events: Array<{ dir: string; name: string; changed?: boolean }> = [];
  ctx.logStage = (dir, name, changed) => events.push({ dir, name, changed });
  await adapter().testModel(ctx);

  // Declared-plan entries (no `changed`) for both custom transforms.
  assert.ok(
    events.some(
      (e) =>
        e.dir === "req" &&
        e.name === "stamp-request" &&
        e.changed === undefined,
    ),
  );
  assert.ok(
    events.some(
      (e) =>
        e.dir === "resp" &&
        e.name === "stamp-response" &&
        e.changed === undefined,
    ),
  );
  // Per-apply entries (with a boolean `changed`) for the same two stages,
  // proving both the request AND response passes were actually traced, not
  // just declared. `changed` is reference-identity (applyBodyTransforms:
  // `next !== out`) — stamp-request/stamp-response mutate the body in place
  // and return the same reference, so it's `false` here, same as it would be
  // for any in-place mutation on a live request's trace.
  assert.ok(
    events.some(
      (e) =>
        e.dir === "req" && e.name === "stamp-request" && e.changed === false,
    ),
  );
  assert.ok(
    events.some(
      (e) =>
        e.dir === "resp" && e.name === "stamp-response" && e.changed === false,
    ),
  );
});

test("probeEndpoint: with no ctx.logStage, tracing is skipped entirely (default, zero cost)", async () => {
  const { ctx } = fakeCtx({}, { json: () => ({ ok: true }) });
  assert.equal(ctx.logStage, undefined);
  const result = await adapter().testModel(ctx);
  assert.equal(result.ok, true); // unaffected either way
});

// Regression coverage: a PLAIN OpenAICompatibleAdapter subclass with NO
// override at any layer (no requestTransforms/responseTransforms, no
// quirks.defaultTransforms) — e.g. deepseek/gemini/glm/openrouter/the generic
// openai-compatible catalog entry — used to trace NOTHING via probeEndpoint(),
// because probeEndpoint() only ever composed `this.transforms(...)` (the
// adapter's own bag). Only example-custom.ts (which declares its own
// requestTransforms/responseTransforms) ever showed a stage. probeEndpoint()
// now composes the SAME builtin+family+adapter+model stack a live request
// gets, so even a fully bare adapter still traces the all-provider builtin
// defaults (Anthropic hooks for a messages hop, <thinking> extraction for
// chat/messages/responses).
class BareAdapter extends OpenAICompatibleAdapter {
  async testModel(ctx: TestModelCtx): Promise<TestModelResult> {
    return this.probeEndpoint(ctx, WireKind.Chat, {
      body: minimalProbeBody(WireKind.Chat, ctx.model),
    });
  }
}

test("probeEndpoint: a bare adapter with zero overrides still traces the builtin all-provider defaults", async () => {
  const bare = new BareAdapter({
    id: "bare",
    label: "Bare",
    blurb: "no overrides at any layer",
    brand: "openai",
    defaults: { format: "openai", endpoints: ["chat"] },
    fields: [],
  });
  const { ctx } = fakeCtx(
    {},
    { json: () => ({ choices: [{ message: { content: "hi" } }] }) },
  );
  const events: Array<{ dir: string; name: string }> = [];
  ctx.logStage = (dir, name) => events.push({ dir, name });
  const result = await bare.testModel(ctx);
  assert.equal(result.ok, true);
  // The builtin <thinking> extraction default (response, tagged "chat") is the
  // one all-provider default that applies to every chat-format probe — this
  // is exactly the stage that was silently missing before this fix.
  assert.ok(
    events.some((e) => e.dir === "resp" && e.name === "thinking:chat"),
    `expected a "thinking:chat" trace entry; got: ${JSON.stringify(events)}`,
  );
});

test("probeEndpoint: ctx.ownTransforms (the imported model's own config) is layered in and traced too", async () => {
  const bare = new BareAdapter({
    id: "bare2",
    label: "Bare",
    blurb: "t",
    brand: "openai",
    defaults: { format: "openai", endpoints: ["chat"] },
    fields: [],
  });
  const { ctx } = fakeCtx(
    { ownTransforms: [{ id: "system-prepend", phase: "request", params: { text: "hi" } }] },
    { json: () => ({ choices: [{ message: { content: "hi" } }] }) },
  );
  const events: Array<{ dir: string; name: string }> = [];
  ctx.logStage = (dir, name) => events.push({ dir, name });
  await bare.testModel(ctx);
  assert.ok(events.some((e) => e.dir === "req" && e.name === "model:system-prepend"));
});

test("minimalProbeBody returns a schema-typed, minimal one-token request per kind", () => {
  const chat = minimalProbeBody(WireKind.Chat, "m");
  assert.equal(chat.model, "m");
  assert.ok(Array.isArray(chat.messages));

  const messages = minimalProbeBody(WireKind.Messages, "m");
  assert.equal(messages.model, "m");
  assert.ok(Array.isArray(messages.messages));
  assert.equal(typeof messages.max_tokens, "number");

  const responses = minimalProbeBody(WireKind.Responses, "m");
  assert.equal(responses.model, "m");
  assert.equal(typeof responses.input, "string");
});

test("default testModel() is a dummy stub — no network call, always ok", async () => {
  // OpenAICompatibleAdapter overrides testModel() with a real probeEndpoint()
  // call (see below), so this exercises the base ProviderAdapter default via
  // AnthropicCompatibleAdapter, which declares no override.
  const anthropic = new AnthropicCompatibleAdapter({
    id: "plain-anthropic",
    label: "Plain",
    blurb: "t",
    brand: "anthropic",
    defaults: { format: "anthropic", endpoints: ["messages"] },
    fields: [],
  });
  const { ctx, calls } = fakeCtx({}, { json: () => ({}) });
  const result = await anthropic.testModel(ctx);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 0); // never touched ctx.request
  assert.equal((result.data as { dummy: boolean }).dummy, true);
});

test("OpenAICompatibleAdapter's own testModel() sends a real 1-token probe (not a stub)", async () => {
  const oai = new OpenAICompatibleAdapter({
    id: "plain",
    label: "Plain",
    blurb: "t",
    brand: "openai",
    defaults: { format: "openai", endpoints: ["chat"] },
    fields: [],
  });
  const { ctx, calls } = fakeCtx(
    {},
    {
      json: () => ({
        choices: [{ message: { content: "hi" } }],
      }),
    },
  );
  const result = await oai.testModel(ctx);
  assert.equal(calls.length, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { reply: "hi" });
});
