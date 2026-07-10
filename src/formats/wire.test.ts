// Wire-type mapping + typed-converter smoke tests.
//
// The wire/ module gives shared typed shapes for the three formats and the
// WireRequest/WireResponse/WireStreamEvent mappings the tagged transform
// factories key off. These tests assert the mappings resolve to the right types
// (compile-time) and that the retyped converters still round-trip a body through
// them (runtime).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  messagesRequestToChat,
  chatRequestToMessages,
} from "./converters/chat-messages";
import type {
  WireRequest,
  WireResponse,
  WireStreamEvent,
  AnthropicMessagesRequest,
  ChatCompletionRequest,
  ChatCompletionChunk,
} from "./wire";

// --- mapping types resolve correctly (compile-time assertions) -------------

test("WireRequest/Response/StreamEvent map each format to its type", () => {
  // These assignments only compile if the conditional types resolve right.
  const chatReq: WireRequest<"chat"> = { model: "m", messages: [] };
  const msgReq: WireRequest<"messages"> = { model: "m", messages: [] };
  const respReq: WireRequest<"responses"> = { model: "m", input: "hi" };
  const chatResp: WireResponse<"chat"> = { id: "x", choices: [] };
  const chatEvt: WireStreamEvent<"chat"> = {
    object: "chat.completion.chunk",
    choices: [{ delta: { content: "hi" } }],
  };
  assert.equal(chatReq.model, "m");
  assert.equal(msgReq.model, "m");
  assert.equal(respReq.input, "hi");
  assert.equal(chatResp.id, "x");
  assert.equal(
    (chatEvt.choices as ChatCompletionChunk["choices"])![0].delta!.content,
    "hi",
  );
});

// --- typed converters round-trip -------------------------------------------

test("messagesRequestToChat consumes AnthropicMessagesRequest, yields chat", () => {
  const req: AnthropicMessagesRequest = {
    model: "claude",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
  };
  const chat = messagesRequestToChat(req);
  assert.equal(chat.model, "claude");
  assert.equal(chat.max_tokens, 100);
  assert.ok(Array.isArray(chat.messages));
  assert.equal(chat.messages![0].role, "user");
});

test("chatRequestToMessages consumes ChatCompletionRequest, yields messages", () => {
  const req: ChatCompletionRequest = {
    model: "gpt",
    messages: [
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ],
  };
  const msg = chatRequestToMessages(req);
  assert.equal(msg.model, "gpt");
  assert.equal(msg.system, "be terse");
  assert.ok(Array.isArray(msg.messages));
});
