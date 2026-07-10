// Format-agnostic web-tool surface tests.
//
// The same hosted web tools must be detected + rewritten whatever wire format a
// hop speaks — a Claude model behind an OpenAI-type provider sends chat-shaped
// tool defs, a native Anthropic hop sends messages-shaped ones. tool-ops renders
// the neutral defs per format; tools.ts detects + rewrites through it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toWireToolDef,
  readToolCalls,
  toolResult,
  type NeutralToolDef,
} from "./tool-ops";
import { detectWebTools, rewriteRequest, WEB_SEARCH } from "./tools";
import { chatRequestToMessages } from "../formats/converters/chat-messages";

const def: NeutralToolDef = {
  name: WEB_SEARCH,
  description: "search",
  schema: { type: "object", properties: { q: { type: "string" } } },
};

// --- tool def rendering per format -----------------------------------------

test("toWireToolDef renders chat/messages/responses shapes", () => {
  const chat = toWireToolDef("chat", def);
  assert.equal(chat.type, "function");
  assert.equal((chat.function as { name: string }).name, WEB_SEARCH);
  assert.ok((chat.function as { parameters?: unknown }).parameters);

  const msg = toWireToolDef("messages", def);
  assert.equal(msg.name, WEB_SEARCH);
  assert.ok(msg.input_schema); // messages uses input_schema

  const resp = toWireToolDef("responses", def);
  assert.equal(resp.type, "function");
  assert.equal(resp.name, WEB_SEARCH);
  assert.ok(resp.parameters);
});

// --- detection is format-agnostic ------------------------------------------

test("detectWebTools finds hosted web_search in messages-shaped tools", () => {
  const body = {
    tools: [{ type: "web_search_20250305", name: "web_search" }],
  };
  assert.deepEqual(detectWebTools(body), { search: true, fetch: false });
});

test("detectWebTools finds hosted web_search in chat-shaped tools", () => {
  // Chat tool defs nest the name under function.name.
  const body = {
    tools: [{ type: "function", function: { name: "web_search" } }],
  };
  assert.deepEqual(detectWebTools(body), { search: true, fetch: false });
});

test("chat web-tool request normalizes to Messages shape with detection intact", () => {
  // The engine converts a Chat-client web-tool request to Messages shape before
  // the loop runs (a Claude model served via /v1/chat/completions). After the
  // conversion the hosted tool is still detectable + the messages carry over.
  const chatBody = {
    model: "claude-via-openai",
    messages: [{ role: "user", content: "search the web for cats" }],
    tools: [
      { type: "function", function: { name: "web_search", parameters: {} } },
    ],
  };
  // Detection works on the raw chat body (trigger side).
  assert.deepEqual(detectWebTools(chatBody), { search: true, fetch: false });
  // After normalization the body is Messages-shaped and still detectable.
  const messagesBody = chatRequestToMessages(chatBody);
  assert.ok(Array.isArray(messagesBody.messages));
  assert.deepEqual(detectWebTools(messagesBody as Record<string, unknown>), {
    search: true,
    fetch: false,
  });
});

// --- rewrite renders defs in the requested format --------------------------

test("rewriteRequest injects messages-shaped defs by default", () => {
  const body = {
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    stream: true,
    messages: [],
  };
  const out = rewriteRequest(body, { search: true, fetch: false });
  const tools = out.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "web_search");
  assert.ok(tools[0].input_schema); // messages shape
  assert.equal(out.stream, undefined); // stream forced off for the loop
});

test("rewriteRequest injects chat-shaped defs when fmt=chat", () => {
  const body = {
    tools: [{ type: "function", function: { name: "web_search" } }],
    messages: [],
  };
  const out = rewriteRequest(body, { search: true, fetch: false }, "chat");
  const tools = out.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  assert.equal((tools[0].function as { name: string }).name, "web_search");
});

test("rewriteRequest keeps non-web client tools untouched", () => {
  const body = {
    tools: [
      { name: "get_weather", input_schema: {} },
      { type: "web_search_20250305", name: "web_search" },
    ],
    messages: [],
  };
  const out = rewriteRequest(body, { search: true, fetch: false });
  const names = (out.tools as Array<{ name: string }>).map((t) => t.name);
  assert.deepEqual(names, ["get_weather", "web_search"]);
});

// --- reading tool calls back out per format --------------------------------

test("readToolCalls normalizes chat tool_calls", () => {
  const msg = {
    tool_calls: [
      { id: "c1", function: { name: "web_search", arguments: '{"q":"hi"}' } },
    ],
  };
  const calls = readToolCalls("chat", msg);
  assert.deepEqual(calls, [
    { id: "c1", name: "web_search", input: { q: "hi" } },
  ]);
});

test("readToolCalls normalizes messages tool_use blocks", () => {
  const blocks = [
    { type: "text", text: "thinking" },
    { type: "tool_use", id: "t1", name: "web_search", input: { q: "hi" } },
  ];
  const calls = readToolCalls("messages", blocks);
  assert.deepEqual(calls, [
    { id: "t1", name: "web_search", input: { q: "hi" } },
  ]);
});

test("readToolCalls normalizes responses function_call items", () => {
  const items = [
    {
      type: "function_call",
      call_id: "f1",
      name: "web_search",
      arguments: '{"q":"hi"}',
    },
  ];
  const calls = readToolCalls("responses", items);
  assert.deepEqual(calls, [
    { id: "f1", name: "web_search", input: { q: "hi" } },
  ]);
});

// --- tool results per format -----------------------------------------------

test("toolResult builds the right shape per format", () => {
  assert.deepEqual(toolResult("chat", { id: "c1" }, "out"), {
    role: "tool",
    tool_call_id: "c1",
    content: "out",
  });
  assert.deepEqual(toolResult("messages", { id: "t1" }, "out"), {
    type: "tool_result",
    tool_use_id: "t1",
    content: "out",
  });
  assert.deepEqual(toolResult("responses", { id: "f1" }, "out"), {
    type: "function_call_output",
    call_id: "f1",
    output: "out",
  });
});
