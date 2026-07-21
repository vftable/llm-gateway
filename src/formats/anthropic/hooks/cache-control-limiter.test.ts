import { test } from "node:test";
import assert from "node:assert/strict";
import { limitAnthropicCacheControl } from "./cache-control-limiter";
import type { AnthropicMessagesRequest } from "../../pipeline";

const cc = () => ({ type: "ephemeral" as const });

function countCacheControl(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value))
    return value.reduce((sum, entry) => sum + countCacheControl(entry), 0);
  const bag = value as Record<string, unknown>;
  return (
    ("cache_control" in bag ? 1 : 0) +
    Object.entries(bag).reduce(
      (sum, [key, entry]) =>
        sum + (key === "cache_control" ? 0 : countCacheControl(entry)),
      0,
    )
  );
}

test("cache-control limiter preserves requests with four breakpoints", () => {
  const body: AnthropicMessagesRequest = {
    cache_control: cc(),
    system: [{ type: "text", text: "system", cache_control: cc() }],
    tools: [{ name: "lookup", cache_control: cc() }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hello", cache_control: cc() }],
      },
    ],
  };

  assert.equal(limitAnthropicCacheControl(body), body);
  assert.equal(countCacheControl(body), 4);
});

test("cache-control limiter keeps stable-prefix breakpoints and removes every excess occurrence", () => {
  const earlySystem = {
    type: "text" as const,
    text: "early",
    cache_control: cc(),
  };
  const lastSystem = {
    type: "text" as const,
    text: "last",
    cache_control: cc(),
  };
  const earlyTool = { name: "early", cache_control: cc() };
  const lastTool = { name: "last", cache_control: cc() };
  const earlyMessage = { type: "text", text: "early", cache_control: cc() };
  const lastMessage = { type: "text", text: "last", cache_control: cc() };
  const nestedToolResult = {
    type: "tool_result",
    tool_use_id: "tool-1",
    content: [{ type: "text", text: "nested", cache_control: cc() }],
  };

  const body: AnthropicMessagesRequest = {
    cache_control: cc(),
    system: [earlySystem, lastSystem],
    tools: [earlyTool, lastTool],
    messages: [
      { role: "user", content: [earlyMessage, nestedToolResult] },
      { role: "user", content: [lastMessage] },
    ],
  };

  limitAnthropicCacheControl(body);

  assert.equal(countCacheControl(body), 4);
  assert.ok(body.cache_control);
  assert.ok(lastSystem.cache_control);
  assert.ok(lastTool.cache_control);
  assert.ok(lastMessage.cache_control);
  assert.equal(earlySystem.cache_control, undefined);
  assert.equal(earlyTool.cache_control, undefined);
  assert.equal(earlyMessage.cache_control, undefined);
  assert.equal(
    (nestedToolResult.content[0] as Record<string, unknown>).cache_control,
    undefined,
  );
});

test("cache-control limiter prefers dual tool-turn anchors over excess top-level markers", () => {
  const assistantTool = {
    type: "tool_use",
    id: "tool-1",
    name: "lookup",
    input: {},
    cache_control: cc(),
  };
  const userTail = {
    type: "tool_result",
    tool_use_id: "tool-1",
    content: "ok",
    cache_control: cc(),
  };
  const body: AnthropicMessagesRequest = {
    cache_control: cc(),
    system: [{ type: "text", text: "system", cache_control: cc() }],
    tools: [{ name: "lookup", cache_control: cc() }],
    messages: [
      { role: "assistant", content: [assistantTool] },
      { role: "user", content: [userTail] },
    ],
  };

  limitAnthropicCacheControl(body);

  assert.equal(countCacheControl(body), 4);
  assert.equal(body.cache_control, undefined);
  assert.ok((body.system as Array<Record<string, unknown>>)[0].cache_control);
  assert.ok((body.tools as Array<Record<string, unknown>>)[0].cache_control);
  assert.ok(assistantTool.cache_control);
  assert.ok(userTail.cache_control);
});

test("cache-control limiter counts null and malformed marker properties", () => {
  const extras = [
    { type: "text", text: "one", cache_control: null },
    { type: "text", text: "two", cache_control: "bad" },
    { type: "text", text: "three", cache_control: 1 },
    { type: "text", text: "four", cache_control: cc() },
    { type: "text", text: "five", cache_control: cc() },
  ];
  const body = {
    messages: [{ role: "user", content: extras }],
  } as unknown as AnthropicMessagesRequest;

  limitAnthropicCacheControl(body);

  assert.equal(countCacheControl(body), 4);
  assert.equal("cache_control" in extras[0], false);
});

test("cache-control limiter is idempotent", () => {
  const body: AnthropicMessagesRequest = {
    cache_control: cc(),
    system: [
      { type: "text", text: "a", cache_control: cc() },
      { type: "text", text: "b", cache_control: cc() },
    ],
    tools: [
      { name: "a", cache_control: cc() },
      { name: "b", cache_control: cc() },
    ],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "c", cache_control: cc() }],
      },
    ],
  };

  limitAnthropicCacheControl(body);
  const once = JSON.stringify(body);
  limitAnthropicCacheControl(body);
  assert.equal(JSON.stringify(body), once);
  assert.equal(countCacheControl(body), 4);
});
