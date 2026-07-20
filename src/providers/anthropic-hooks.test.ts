// Format-tagged request hooks + endpoint-driven wire format.
//
// The Anthropic request hooks are now format-tagged transforms ("messages"): an
// all-provider request default the engine adds to every route, placed by
// buildTransformPlan where the body is in Messages shape, and internally gated on
// `ctx.providerFmt === "messages"` so they engage only for a hop that actually
// emits Messages (native Anthropic provider, or an OpenAI-catalog provider whose
// chain link points at /v1/messages). The endpoint suffix chosen per hop drives
// that format via each adapter's routeFor().

import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropic } from "./catalog/anthropic";
import { openai } from "./catalog/openai";
import type { Provider } from "../types";
import type { TransformCtx } from "../formats/pipeline";
import { defaultAnthropicRequestHooks } from "../formats/anthropic/hooks/stack";

const provider = (over: Partial<Provider> = {}): Provider =>
  ({
    id: "p",
    catalogId: "anthropic",
    nativeConversion: false,
    endpoints: [],
    basePath: "",
    ...over,
  }) as unknown as Provider;

const BASE = [
  "anthropic:thinking-signature",
  "anthropic:max-tokens",
  "anthropic:prefill",
  "anthropic:sanitize-request",
  "anthropic:thinking-mode",
  "anthropic:thinking-config",
  "anthropic:cache-control-limit",
];

function hookCtx(over: Partial<TransformCtx> = {}): TransformCtx {
  return {
    provider: provider(),
    clientFmt: "messages",
    providerFmt: "messages",
    upstreamModel: "claude-opus-4-8",
    maxOutputTokens: null,
    ...over,
  };
}

// --- format-tagged hooks ---------------------------------------------------

test("defaultAnthropicRequestHooks are tagged messages, in order", () => {
  const hooks = defaultAnthropicRequestHooks();
  assert.deepEqual(
    hooks.map((h) => h.name),
    BASE,
  );
  assert.ok(
    hooks.every((h) => h.format === "messages" && h.phase === "request"),
  );
});

test("hooks engage only when providerFmt is messages (gated)", () => {
  const clamp = defaultAnthropicRequestHooks().find(
    (h) => h.name === "anthropic:max-tokens",
  )!;
  // providerFmt messages -> clamps.
  const clamped = clamp.apply(
    { max_tokens: 999999 },
    hookCtx({ maxOutputTokens: 64000 }),
  );
  assert.equal(clamped.max_tokens, 64000);
  // providerFmt chat (pre-conversion shape) -> no-op passthrough.
  const untouched = clamp.apply(
    { max_tokens: 999999 },
    hookCtx({ providerFmt: "chat", maxOutputTokens: 64000 }),
  );
  assert.equal(untouched.max_tokens, 999999);
});

// --- endpoint suffix drives the wire format --------------------------------

test("OpenAI provider: a /v1/messages link emits the Messages format", () => {
  // Native default (no link) is chat.
  assert.equal(openai.routeFor("chat", provider(), null).providerFmt, "chat");
  // A per-link /v1/messages endpoint flips this hop to messages (path + format).
  const plan = openai.routeFor("chat", provider(), "/v1/messages");
  assert.equal(plan.providerFmt, "messages");
  assert.equal(plan.forwardPath, "/v1/messages");
});

test("Anthropic provider: a /v1/chat/completions link emits the Chat format", () => {
  assert.equal(
    anthropic.routeFor("messages", provider(), null).providerFmt,
    "messages",
  );
  const plan = anthropic.routeFor(
    "messages",
    provider(),
    "/v1/chat/completions",
  );
  assert.equal(plan.providerFmt, "chat");
  assert.equal(plan.forwardPath, "/v1/chat/completions");
});

test("a /v1/responses link emits the Responses format on any provider", () => {
  assert.equal(
    openai.routeFor("chat", provider(), "/v1/responses").providerFmt,
    "responses",
  );
  assert.equal(
    anthropic.routeFor("messages", provider(), "/v1/responses").providerFmt,
    "responses",
  );
});

// --- adapters no longer carry the hooks themselves -------------------------

test("adapters expose no per-adapter request hooks (hooks are engine-injected)", () => {
  assert.deepEqual(anthropic.transforms(provider()).request ?? [], []);
  assert.deepEqual(openai.transforms(provider()).request ?? [], []);
});
