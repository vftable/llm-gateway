import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnthropicMessagesRequest } from "../../wire";
import { finalizeClaudeCodeRequest, subscriptionRequestStack } from "./index";
import {
  CCH_PLACEHOLDER,
  CC_VERSION,
  computeCchForBody,
  serializeBody,
} from "./billing";

const cc = { type: "ephemeral" as const };

function countMarkers(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value))
    return value.reduce((sum, entry) => sum + countMarkers(entry), 0);
  const bag = value as Record<string, unknown>;
  return (
    ("cache_control" in bag ? 1 : 0) +
    Object.entries(bag).reduce(
      (sum, [key, entry]) =>
        sum + (key === "cache_control" ? 0 : countMarkers(entry)),
      0,
    )
  );
}

test("Claude Code computes cch after final cache limiting", () => {
  const assistantTool = {
    type: "tool_use",
    id: "tool-1",
    name: "Read",
    input: {},
    cache_control: cc,
  };
  const userTail = {
    type: "tool_result",
    tool_use_id: "tool-1",
    content: "ok",
    cache_control: cc,
  };
  const body: AnthropicMessagesRequest = {
    cache_control: cc,
    system: [{ type: "text", text: "system", cache_control: cc }],
    tools: [{ name: "Read", input_schema: {}, cache_control: cc }],
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [assistantTool] },
      { role: "user", content: [userTail] },
    ],
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
  };

  const finalized = finalizeClaudeCodeRequest(body);

  assert.equal(countMarkers(finalized.body), 4);
  assert.equal(finalized.body.cache_control, undefined);
  assert.ok(assistantTool.cache_control);
  assert.ok(userTail.cache_control);

  const placeholderBilling = finalized.billingHeader.replace(
    /cch=[0-9a-f]{5};$/,
    `cch=${CCH_PLACEHOLDER};`,
  );
  const placeholderBody = structuredClone(finalized.body);
  const system = placeholderBody.system as Array<{ text: string }>;
  system[0] = {
    ...system[0],
    text: `x-anthropic-billing-header: ${placeholderBilling}`,
  };
  const expected = computeCchForBody(
    serializeBody(placeholderBody),
    CC_VERSION,
  );
  assert.match(finalized.billingHeader, new RegExp(`cch=${expected};$`));
});

test("OAuth billing is no longer computed by the early transform stack", () => {
  assert.equal(
    subscriptionRequestStack.some(
      (stage) => stage.name === "claude-code:oauth-billing",
    ),
    false,
  );
});
