// Transform pipeline tests: a custom adapter transform must appear in — and run
// through — the composed plan for both the buffered (request/response) and
// streaming paths, and the built-in format conversion must compose correctly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "stream";
import {
  buildTransformPlan,
  applyBodyTransforms,
  type AdapterTransforms,
  type TransformCtx,
  type Json,
} from "./pipeline";
import type { Provider } from "../types";

const provider = { id: "p" } as unknown as Provider;

function ctx(clientFmt: TransformCtx["clientFmt"], providerFmt: TransformCtx["providerFmt"]): TransformCtx {
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
  assert.deepEqual(plan.request.map((t) => t.name), ["custom:stamp-req"]);
  assert.deepEqual(plan.response.map((t) => t.name), ["custom:stamp-resp"]);
  assert.deepEqual(plan.stream.map((t) => t.name), ["custom:stream"]);
});

test("custom transforms run after the format bridge when converting", () => {
  const plan = buildTransformPlan(
    "chat",
    { forwardPath: "/v1/messages", providerFmt: "messages" },
    extra,
  );
  // Request: format(chat->messages) THEN the custom stage.
  assert.deepEqual(plan.request.map((t) => t.name), [
    "format:chat->messages",
    "custom:stamp-req",
  ]);
  // Response: format(messages->chat) THEN the custom stage.
  assert.deepEqual(plan.response.map((t) => t.name), [
    "format:messages->chat",
    "custom:stamp-resp",
  ]);
  // Stream: format bridge THEN custom.
  assert.deepEqual(plan.stream.map((t) => t.name), [
    "stream:messages->chat",
    "custom:stream",
  ]);
});

test("applyBodyTransforms runs the custom stage (buffered path parity)", () => {
  const plan = buildTransformPlan(
    "chat",
    { forwardPath: "/v1/chat/completions", providerFmt: "chat" },
    extra,
  );
  const reqOut = applyBodyTransforms(plan.request, { m: 1 }, ctx("chat", "chat"));
  assert.equal(reqOut._req, true);
  const respOut = applyBodyTransforms(plan.response, { m: 1 }, ctx("chat", "chat"));
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

test("unsupported conversion is surfaced, not silently dropped", () => {
  // responses -> messages has no converter table entry.
  const plan = buildTransformPlan("responses", {
    forwardPath: "/v1/messages",
    providerFmt: "messages",
  });
  assert.ok(plan.unsupported, "expected unsupported to be set");
});
