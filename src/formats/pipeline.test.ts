// Transform pipeline tests: a custom adapter transform must appear in — and run
// through — the composed plan for both the buffered (request/response) and
// streaming paths, and the built-in format conversion must compose correctly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "stream";
import {
  buildTransformPlan,
  applyBodyTransforms,
  onRequest,
  onResponse,
  onStreamEvent,
  type AdapterTransforms,
  type TransformCtx,
  type Json,
} from "./pipeline";
import type { Provider } from "../types";

const provider = { id: "p" } as unknown as Provider;

function ctx(
  clientFmt: TransformCtx["clientFmt"],
  providerFmt: TransformCtx["providerFmt"],
): TransformCtx {
  return { provider, clientFmt, providerFmt };
}

// A custom request transform that stamps a marker, and a matching response one.
const stampReq = {
  name: "custom:stamp-req",
  apply: (b: Json) => ({ ...b, _req: true }),
};
const stampResp = {
  name: "custom:stamp-resp",
  apply: (b: Json) => ({ ...b, _resp: true }),
};
const passStream = {
  name: "custom:stream",
  create: () => new PassThrough(),
};
const extra: AdapterTransforms = {
  request: [stampReq],
  response: [stampResp],
  stream: [passStream],
};

test("custom transforms appear in the plan for a same-format provider", () => {
  const plan = buildTransformPlan(
    "chat",
    { forwardPath: "/v1/chat/completions", providerFmt: "chat" },
    extra,
  );
  // No format conversion (chat->chat), so only the custom stages are present.
  assert.deepEqual(
    plan.request.map((t) => t.name),
    ["custom:stamp-req"],
  );
  assert.deepEqual(
    plan.response.map((t) => t.name),
    ["custom:stamp-resp"],
  );
  assert.deepEqual(
    plan.stream.map((t) => t.name),
    ["custom:stream"],
  );
});

test("custom transforms run after the format bridge when converting", () => {
  const plan = buildTransformPlan(
    "chat",
    { forwardPath: "/v1/messages", providerFmt: "messages" },
    extra,
  );
  // Request: format(chat->messages) THEN the custom stage.
  assert.deepEqual(
    plan.request.map((t) => t.name),
    ["format:chat->messages", "custom:stamp-req"],
  );
  // Response: format(messages->chat) THEN the custom stage.
  assert.deepEqual(
    plan.response.map((t) => t.name),
    ["format:messages->chat", "custom:stamp-resp"],
  );
  // Stream: format bridge THEN custom.
  assert.deepEqual(
    plan.stream.map((t) => t.name),
    ["stream:messages->chat", "custom:stream"],
  );
});

test("applyBodyTransforms runs the custom stage (buffered path parity)", () => {
  const plan = buildTransformPlan(
    "chat",
    { forwardPath: "/v1/chat/completions", providerFmt: "chat" },
    extra,
  );
  const reqOut = applyBodyTransforms(
    plan.request,
    { m: 1 },
    ctx("chat", "chat"),
  );
  assert.equal(reqOut._req, true);
  const respOut = applyBodyTransforms(
    plan.response,
    { m: 1 },
    ctx("chat", "chat"),
  );
  assert.equal(respOut._resp, true);
});

test("stream stage instances are constructed for the streaming path", () => {
  const plan = buildTransformPlan(
    "chat",
    { forwardPath: "/v1/chat/completions", providerFmt: "chat" },
    extra,
  );
  // The engine does `plan.stream.map(s => s.create(ctx))`; assert that yields a
  // real stream (parity with what streamConvert assembles).
  const stages = plan.stream.map((s) => s.create(ctx("chat", "chat")));
  assert.equal(stages.length, 1);
  assert.ok(typeof (stages[0] as PassThrough).pipe === "function");
});

test("onStage observer reports each composed stage once", () => {
  const seen: string[] = [];
  buildTransformPlan(
    "chat",
    { forwardPath: "/v1/messages", providerFmt: "messages" },
    extra,
    (dir, name) => seen.push(`${dir}:${name}`),
  );
  assert.deepEqual(seen, [
    "req:format:chat->messages",
    "req:custom:stamp-req",
    "resp:format:messages->chat",
    "resp:custom:stamp-resp",
    "stream:stream:messages->chat",
    "stream:custom:stream",
  ]);
});

test("an upstream-supplied `unsupported` (e.g. no endpoint match) is surfaced, not silently dropped", () => {
  // buildTransformPlan's own plan.unsupported passthrough — set by the
  // adapter's routeFor() before the transform tables are ever consulted
  // (e.g. a provider that accepts none of the three wire kinds). Distinct
  // from a missing converter-table entry: see the "all 6 cross-format pairs
  // are supported" test below for that half of the contract.
  const plan = buildTransformPlan("responses", {
    forwardPath: "/v1/messages",
    providerFmt: "messages",
    unsupported: "provider accepts no endpoint this hop could resolve to",
  });
  assert.ok(plan.unsupported, "expected unsupported to be set");
});

test("all 6 cross-format request/response pairs are supported (no gateway-side gap)", () => {
  // Every (clientFmt, providerFmt) pair among the 3 wire formats must have
  // BOTH a request and a response converter — this is what lets, e.g., a
  // chat or messages client be routed to an OpenAI Responses-native model
  // (preferredEndpoint() pins GPT-5-class ids to /v1/responses) without the
  // hop being skipped as unsupported. responses<->messages is the two-hop
  // case (via chat — see REQUEST_CONVERTERS/RESPONSE_CONVERTERS in
  // pipeline.ts); this test doesn't care HOW a pair is implemented, only
  // that buildTransformPlan resolves it without `unsupported`.
  const FMTS = ["chat", "messages", "responses"] as const;
  for (const clientFmt of FMTS) {
    for (const providerFmt of FMTS) {
      if (clientFmt === providerFmt) continue;
      const plan = buildTransformPlan(clientFmt, {
        forwardPath: "/v1/x",
        providerFmt,
      });
      assert.equal(
        plan.unsupported,
        undefined,
        `${clientFmt} -> ${providerFmt} should be supported, got: ${plan.unsupported}`,
      );
      // Non-streaming AND streaming both need a resolved path — a plan
      // that's "supported" for buffered but silently has zero stream stages
      // would 502 the moment a client sets stream:true (see engine.ts
      // streamConvert's route.convert && !route.streamBridged check).
      assert.ok(
        plan.stream.some((s) => s.name.startsWith("stream:")),
        `${clientFmt} -> ${providerFmt} should have a stream bridge stage`,
      );
    }
  }
});

// --- tagged transform placement --------------------------------------------

test("tagged request transforms: clientFmt runs pre-conversion, providerFmt post", () => {
  const pre = onRequest("chat", "pre", (b) => b); // client shape (chat)
  const post = onRequest("messages", "post", (b) => b); // provider shape (messages)
  const plan = buildTransformPlan(
    "chat",
    { forwardPath: "/v1/messages", providerFmt: "messages" },
    { request: [post, pre] }, // order in the bag shouldn't matter across buckets
  );
  assert.deepEqual(
    plan.request.map((t) => t.name),
    ["pre", "format:chat->messages", "post"],
  );
});

test("tagged response/stream transforms: providerFmt pre-bridge, clientFmt post", () => {
  const preResp = onResponse("messages", "pre-resp", (b) => b); // provider shape
  const postResp = onResponse("chat", "post-resp", (b) => b); // client shape
  const preStream = onStreamEvent("messages", "pre-strm", (e) => e);
  const postStream = onStreamEvent("chat", "post-strm", (e) => e);
  const plan = buildTransformPlan(
    "chat",
    { forwardPath: "/v1/messages", providerFmt: "messages" },
    { response: [postResp, preResp], stream: [postStream, preStream] },
  );
  assert.deepEqual(
    plan.response.map((t) => t.name),
    ["pre-resp", "format:messages->chat", "post-resp"],
  );
  assert.deepEqual(
    plan.stream.map((t) => t.name),
    ["pre-strm", "stream:messages->chat", "post-strm"],
  );
});

test("a tagged transform for a format this hop never produces is skipped", () => {
  // chat->messages hop never touches the responses shape, so a responses-tagged
  // stage is dropped entirely.
  const orphan = onRequest("responses", "orphan", (b) => b);
  const plan = buildTransformPlan(
    "chat",
    { forwardPath: "/v1/messages", providerFmt: "messages" },
    { request: [orphan] },
  );
  assert.deepEqual(
    plan.request.map((t) => t.name),
    ["format:chat->messages"],
  );
});

test("untagged transforms keep the historical post placement", () => {
  const tagged = onRequest("messages", "tagged", (b) => b);
  const untagged = { name: "legacy", apply: (b: Json) => b };
  const plan = buildTransformPlan(
    "chat",
    { forwardPath: "/v1/messages", providerFmt: "messages" },
    { request: [untagged, tagged] },
  );
  // tagged(providerFmt) is post-conversion, untagged is placed after it.
  assert.deepEqual(
    plan.request.map((t) => t.name),
    ["format:chat->messages", "tagged", "legacy"],
  );
});

test("same-format hop: pre and post buckets coincide (no conversion stage)", () => {
  const a = onRequest("chat", "a", (b) => b);
  const plan = buildTransformPlan(
    "chat",
    { forwardPath: "/v1/chat/completions", providerFmt: "chat" },
    { request: [a] },
  );
  // No conversion; the chat-tagged stage still runs (pre bucket, clientFmt==chat).
  assert.deepEqual(
    plan.request.map((t) => t.name),
    ["a"],
  );
});

test("a request transform can rewrite URL + headers via the ctx side-channel", () => {
  // This is the contract the engine relies on: a request hook mutates ctx to
  // ask for URL/header rewrites, and those survive on the SAME ctx object the
  // engine passed in (the engine reads them back after applyBodyTransforms).
  const rewrite = {
    name: "custom:rewrite",
    apply: (b: Json, c: TransformCtx) => {
      c.urlOverride = "https://edge.example.com/v1/chat/completions";
      c.headerOverrides = { "x-edge": "1", authorization: null };
      return b;
    },
  };
  const c = ctx("chat", "chat");
  const out = applyBodyTransforms([rewrite], { m: 1 }, c);
  assert.deepEqual(out, { m: 1 }); // body untouched
  assert.equal(c.urlOverride, "https://edge.example.com/v1/chat/completions");
  assert.deepEqual(c.headerOverrides, { "x-edge": "1", authorization: null });
});
