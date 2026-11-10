// Mistral request-compat scrub: the OpenAPI spec has additionalProperties:false
// on ChatCompletionRequest and every message variant, so anything a client or
// converter adds beyond the spec is a hard 422. These tests pin what the
// mistral:compat stage keeps, drops, renames, and clamps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mistral } from "./mistral";
import {
  buildTransformPlan,
  applyBodyTransforms,
  type Json,
} from "../../formats/pipeline";
import { WireKind, type Provider } from "../../types";

const provider = {
  id: "mistral-test",
  name: "Mistral",
  catalogId: "mistral",
  baseUrl: "https://api.mistral.ai",
  basePath: "",
} as Provider;

// Run the full transform plan of a live chat hop (client chat -> provider chat):
// the mistral:compat stage is tagged the provider format, so it applies
// post-conversion.
function scrub(body: Json): Json {
  const plan = buildTransformPlan(
    WireKind.Chat,
    { forwardPath: "/v1/chat/completions", providerFmt: WireKind.Chat },
    { request: mistral.requestTransforms(provider) },
  );
  return applyBodyTransforms(plan.request, body, {
    provider,
    clientFmt: WireKind.Chat,
    providerFmt: WireKind.Chat,
    upstreamModel: "m",
  } as never) as Json;
}

test("drops OpenAI-platform fields Mistral rejects", () => {
  const out = scrub({
    model: "mistral-large-latest",
    messages: [],
    prompt_cache_retention: "24h",
    prompt_cache_key: "k",
    store: true,
    user: "u1",
    _reasoning_summary: "x",
    _thinking_disabled: true,
  } as Json);
  assert.equal(out.prompt_cache_retention, undefined);
  assert.equal(out.store, undefined);
  assert.equal(out.user, undefined);
  assert.equal(out._reasoning_summary, undefined);
  assert.equal(out._thinking_disabled, undefined);
  // prompt_cache_key IS legal on Mistral chat - kept.
  assert.equal(out.prompt_cache_key, "k");
});

test("renames max_completion_tokens and seed", () => {
  const out = scrub({
    model: "m",
    messages: [],
    max_completion_tokens: 512,
    seed: 7,
  } as Json);
  assert.equal(out.max_tokens, 512);
  assert.equal(out.max_completion_tokens, undefined);
  assert.equal(out.random_seed, 7);
  assert.equal(out.seed, undefined);
});

test("keeps an explicit max_tokens before the rename fallback", () => {
  const out = scrub({
    model: "m",
    messages: [],
    max_tokens: 64,
    max_completion_tokens: 512,
  } as Json);
  assert.equal(out.max_tokens, 64);
});

test("clamps temperature to Mistral's 1.5 cap", () => {
  const out = scrub({
    model: "m",
    messages: [],
    temperature: 2,
  } as Json);
  assert.equal(out.temperature, 1.5);
  assert.equal(
    (scrub({ model: "m", messages: [], temperature: 1.2 } as Json) as { temperature: number }).temperature,
    1.2,
  );
});

test("strips reasoning_content and other non-spec fields from assistant messages", () => {
  const out = scrub({
    model: "m",
    messages: [
      { role: "system", content: "sys", name: "cfg" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "ok",
        reasoning_content: "thinking...",
        reasoning: "thinking...",
        reasoning_details: [{ text: "t" }],
        name: "bot",
        refusal: null,
        function_call: { name: "f", arguments: "{}" },
      },
    ],
  } as Json);
  const msgs = out.messages as Array<Record<string, unknown>>;
  assert.deepEqual(Object.keys(msgs[0]).sort(), ["content", "role"]);
  assert.deepEqual(Object.keys(msgs[1]).sort(), ["content", "role"]);
  assert.deepEqual(Object.keys(msgs[2]).sort(), ["content", "role"]);
});

test("keeps assistant tool_calls and trims each call to spec fields", () => {
  const out = scrub({
    model: "m",
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "f", arguments: "{}", extra: 1 },
            index: 0,
            extra: true,
          },
        ],
      },
    ],
  } as Json);
  const msg = (out.messages as Array<Record<string, unknown>>)[0];
  assert.deepEqual(Object.keys(msg).sort(), ["content", "role", "tool_calls"]);
  const call = (msg.tool_calls as Array<Record<string, unknown>>)[0];
  assert.deepEqual(Object.keys(call).sort(), ["function", "id", "index", "type"]);
  assert.deepEqual(
    Object.keys(call.function as object).sort(),
    ["arguments", "name"],
  );
});

test("tool messages keep content, tool_call_id and name; content defaults to string", () => {
  const out = scrub({
    model: "m",
    messages: [
      { role: "tool", tool_call_id: "c1", name: "f", content: '{"ok":1}', meta: "x" },
      { role: "tool", tool_call_id: "c2" },
    ],
  } as Json);
  const msgs = out.messages as Array<Record<string, unknown>>;
  assert.deepEqual(msgs[0], { content: '{"ok":1}', name: "f", role: "tool", tool_call_id: "c1" });
  assert.deepEqual(msgs[1], { content: "", role: "tool", tool_call_id: "c2" });
});

test("a well-formed Mistral body passes through bread-winner fields untouched", () => {
  const body = {
    model: "mistral-small-latest",
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.7,
    top_p: 0.9,
    max_tokens: 128,
    random_seed: 3,
    safe_prompt: false,
    parallel_tool_calls: true,
    metadata: { session: "abc" },
    response_format: { type: "json_object" },
  };
  assert.deepEqual(scrub(body as Json), body);
});

// --- mistral:cache ----------------------------------------------------------

// Run the plan with a mutable header table, like the engine does.
function scrubWithHeaders(
  body: Json,
  baseUrl = "https://api.mistral.ai",
  headers: Record<string, string> = {},
): { body: Json; headers: Record<string, string> } {
  const p = { ...provider, baseUrl } as Provider;
  const plan = buildTransformPlan(
    WireKind.Chat,
    { forwardPath: "/v1/chat/completions", providerFmt: WireKind.Chat },
    { request: mistral.requestTransforms(p) },
  );
  const out = applyBodyTransforms(plan.request, body, {
    provider: p,
    clientFmt: WireKind.Chat,
    providerFmt: WireKind.Chat,
    upstreamModel: "m",
    headers,
  } as never) as Json;
  return { body: out, headers };
}

test("stamps prompt_cache_key and x-affinity with one stable per-session key", () => {
  const body = {
    model: "m",
    user: "u1",
    messages: [{ role: "user", content: "hi" }],
  } as Json;
  const { body: out, headers } = scrubWithHeaders({ ...body });
  const key = out.prompt_cache_key;
  assert.equal(typeof key, "string");
  assert.equal(headers["x-affinity"], key);
  // Same conversation, one turn later - history only appends.
  const next = scrubWithHeaders({
    ...body,
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "more" },
    ],
  } as Json);
  assert.equal(next.body.prompt_cache_key, key);
  // Different session -> different shard.
  const other = scrubWithHeaders({ ...body, user: "u2" } as Json);
  assert.notEqual(other.body.prompt_cache_key, key);
});

test("derives the key from the stable prefix when no client identity is present", () => {
  const first = scrubWithHeaders({
    model: "m",
    messages: [
      { role: "system", content: "you are terse" },
      { role: "user", content: "hi" },
    ],
  } as Json);
  const second = scrubWithHeaders({
    model: "m",
    messages: [
      { role: "system", content: "you are terse" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
  } as Json);
  assert.equal(first.body.prompt_cache_key, second.body.prompt_cache_key);
  assert.notEqual(first.body.prompt_cache_key, undefined);
});

test("honours a client-supplied prompt_cache_key", () => {
  const { body: out, headers } = scrubWithHeaders({
    model: "m",
    prompt_cache_key: "client-key",
    messages: [{ role: "user", content: "hi" }],
  } as Json);
  assert.equal(out.prompt_cache_key, "client-key");
  assert.equal(headers["x-affinity"], "client-key");
});

test("replaces a client x-affinity (any casing) with the canonical header", () => {
  const { headers } = scrubWithHeaders(
    { model: "m", user: "u1", messages: [{ role: "user", content: "hi" }] } as Json,
    "https://api.mistral.ai",
    { "X-Affinity": "stale", "x-affinity": "stale2" },
  );
  const names = Object.keys(headers).filter((n) =>
    n.toLowerCase() === "x-affinity",
  );
  assert.deepEqual(names, ["x-affinity"]);
  assert.notEqual(headers["x-affinity"], "stale");
  assert.notEqual(headers["x-affinity"], "stale2");
});

test("no affinity stamping for third-party base URLs", () => {
  const { body: out, headers } = scrubWithHeaders(
    { model: "m", user: "u1", messages: [{ role: "user", content: "hi" }] } as Json,
    "https://my-mistral-proxy.example.com",
  );
  assert.equal(headers["x-affinity"], undefined);
  assert.equal(out.prompt_cache_key, "bb82030dbc2bcaba");
});
