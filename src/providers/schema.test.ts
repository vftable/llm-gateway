// Schema-conformance: assert our catalog targets endpoint KINDS the official SDKs
// actually speak. We can't exercise the network here, so we assert coherence
// against the installed @anthropic-ai/sdk and openai packages: the client
// surfaces the resource each wire kind maps to (messages / chat / responses),
// and every template's endpoints are valid kinds backed by an SDK resource.

import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { listProviderTemplates, getAdapter } from ".";
import { WIRE_KINDS, type WireKind } from "../types";

test("official SDK clients expose the resources our kinds map to", () => {
  const anthropic = new Anthropic({ apiKey: "test" });
  assert.ok(anthropic.messages, "anthropic SDK missing .messages");
  assert.equal(typeof anthropic.messages.create, "function");

  const openai = new OpenAI({ apiKey: "test" });
  assert.ok(openai.chat?.completions, "openai SDK missing .chat.completions");
  assert.equal(typeof openai.chat.completions.create, "function");
  assert.ok(openai.responses, "openai SDK missing .responses");
});

test("each template's endpoint kinds are valid + backed by an SDK resource", () => {
  const anthropic = new Anthropic({ apiKey: "test" });
  const openai = new OpenAI({ apiKey: "test" });
  const sdkFor: Record<WireKind, boolean> = {
    chat: !!openai.chat?.completions,
    responses: !!openai.responses,
    messages: !!anthropic.messages,
  };

  for (const t of listProviderTemplates()) {
    for (const kind of t.defaults.endpoints ?? []) {
      assert.ok(
        (WIRE_KINDS as string[]).includes(kind),
        `${t.id} targets unknown endpoint kind ${kind}`,
      );
      assert.ok(sdkFor[kind], `${t.id} kind ${kind} has no SDK resource`);
    }

    // The adapter identifies its own native format (no stored format field).
    const adapter = getAdapter(t.id);
    assert.ok(adapter, `${t.id} has no adapter`);
    if (adapter!.nativeFormat === "anthropic") {
      assert.ok(anthropic.messages, `${t.id} anthropic but SDK lacks messages`);
      // A non-native-conversion anthropic provider must accept the messages kind.
      if (!t.defaults.nativeConversion)
        assert.ok(
          (t.defaults.endpoints ?? []).includes("messages"),
          `${t.id} anthropic must accept the messages kind`,
        );
    } else {
      assert.ok(
        openai.chat?.completions,
        `${t.id} openai but SDK lacks chat.completions`,
      );
    }
  }
});
