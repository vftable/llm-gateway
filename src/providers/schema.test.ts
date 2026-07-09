// Schema-conformance: assert our catalog targets endpoints the official SDKs
// actually speak. We can't exercise the network here, so we assert coherence
// against the installed @anthropic-ai/sdk and openai packages: the client
// surfaces the resource each wire format maps to (messages / chat / responses),
// and every template's endpoints are a subset of what the gateway supports.

import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { listProviderTemplates } from ".";
import {
  ENDPOINT_MESSAGES,
  ENDPOINT_CHAT,
  ENDPOINT_RESPONSES,
} from "../types";

test("official SDK clients expose the resources our formats map to", () => {
  const anthropic = new Anthropic({ apiKey: "test" });
  // Anthropic format -> /v1/messages
  assert.ok(anthropic.messages, "anthropic SDK missing .messages");
  assert.equal(typeof anthropic.messages.create, "function");

  const openai = new OpenAI({ apiKey: "test" });
  // OpenAI format -> /v1/chat/completions (+ /v1/responses)
  assert.ok(openai.chat?.completions, "openai SDK missing .chat.completions");
  assert.equal(typeof openai.chat.completions.create, "function");
  assert.ok(openai.responses, "openai SDK missing .responses");
});

test("each template's endpoints are valid + match its wire format's SDK", () => {
  const anthropic = new Anthropic({ apiKey: "test" });
  const openai = new OpenAI({ apiKey: "test" });
  // The composed path (basePath + endpoint) must end in the suffix of one of
  // the three canonical endpoints.
  const suffixes = [ENDPOINT_MESSAGES, ENDPOINT_CHAT, ENDPOINT_RESPONSES].map(
    (e) => e.replace(/^\/v1/, ""),
  );
  const composedOk = (t: (typeof list)[number], ep: string) => {
    const full = (t.defaults.basePath ?? "") + ep;
    return suffixes.some((s) => full.endsWith(s));
  };
  const list = listProviderTemplates();

  for (const t of list) {
    for (const ep of t.defaults.endpoints ?? [])
      assert.ok(composedOk(t, ep), `${t.id} targets unknown endpoint ${ep}`);

    // The template's declared native format must be backed by that SDK's resource.
    if (t.defaults.format === "anthropic") {
      assert.ok(
        anthropic.messages,
        `${t.id} is anthropic but SDK lacks messages`,
      );
      // A non-native anthropic provider should route to a messages endpoint.
      if (!t.defaults.nativeConversion)
        assert.ok(
          (t.defaults.endpoints ?? []).some((e) => e.endsWith("/messages")),
          `${t.id} anthropic must target a messages endpoint`,
        );
    }
    if (t.defaults.format === "openai") {
      assert.ok(
        openai.chat?.completions,
        `${t.id} is openai but SDK lacks chat.completions`,
      );
    }
  }
});
