// Sonnet 5.5 / Opus 5.5 / Fable 5.1 request-shape rules, from the migration
// guides at https://platform.claude.com/docs/en/models/*/migration-guide.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeThinkingMode } from "./thinking-mode";
import { sanitizeAnthropicRequest } from "./sanitize-request";
import type { AnthropicMessagesRequest } from "../../pipeline";
import { isForcedToolChoiceUnsupported } from "../model-version";

const req = (extra: Record<string, unknown>): AnthropicMessagesRequest =>
  ({ model: "x", max_tokens: 1000, messages: [], ...extra }) as never;

test("sonnet 5.5: disabled -> between_tools", () => {
  const b = normalizeThinkingMode(
    req({ thinking: { type: "disabled" } }),
    "claude-sonnet-5-5",
  );
  assert.deepEqual(b.thinking, { type: "between_tools" });
});

test("sonnet 5.5: between_tools clamps xhigh/max effort to high", () => {
  const b = normalizeThinkingMode(
    req({ thinking: { type: "disabled" }, output_config: { effort: "max" } }),
    "claude-sonnet-5-5",
  );
  assert.equal(b.output_config?.effort, "high");
});

test("sonnet 5.5: enabled -> adaptive; between_tools gets no display", () => {
  const a = normalizeThinkingMode(
    req({ thinking: { type: "enabled", budget_tokens: 2000 } }),
    "claude-sonnet-5-5",
  );
  assert.equal((a.thinking as { type: string }).type, "adaptive");
  const b = normalizeThinkingMode(
    req({ thinking: { type: "between_tools", display: "summarized" } }),
    "claude-sonnet-5-5",
  );
  assert.deepEqual(b.thinking, { type: "between_tools" });
});

test("sonnet 5 keeps disabled", () => {
  const b = normalizeThinkingMode(
    req({ thinking: { type: "disabled" } }),
    "claude-sonnet-5",
  );
  assert.deepEqual(b.thinking, { type: "disabled" });
});

test("opus 5.5: disabled/enabled -> adaptive; opus 5 keeps disabled", () => {
  for (const t of [
    { type: "disabled" },
    { type: "enabled", budget_tokens: 2000 },
  ]) {
    const b = normalizeThinkingMode(req({ thinking: t }), "claude-opus-5-5");
    assert.equal((b.thinking as { type: string }).type, "adaptive");
  }
  const o5 = normalizeThinkingMode(
    req({ thinking: { type: "disabled" } }),
    "claude-opus-5",
  );
  assert.equal((o5.thinking as { type: string }).type, "disabled");
});

test("between_tools falls back on other models", () => {
  assert.equal(
    (
      normalizeThinkingMode(
        req({ thinking: { type: "between_tools" } }),
        "claude-opus-5-5",
      ).thinking as { type: string }
    ).type,
    "adaptive",
  );
  assert.equal(
    (
      normalizeThinkingMode(
        req({ thinking: { type: "between_tools" } }),
        "claude-haiku-4-5-20251001",
      ).thinking as { type: string }
    ).type,
    "disabled",
  );
});

test("forced tool_choice downgraded to auto on 5.5/5.1 models only", () => {
  for (const m of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]) {
    const b = sanitizeAnthropicRequest(
      req({
        tool_choice: { type: "tool", name: "t", disable_parallel_tool_use: true },
      }),
      m,
    );
    assert.deepEqual(b.tool_choice, {
      type: "auto",
      disable_parallel_tool_use: true,
    });
  }
  for (const m of ["claude-sonnet-5", "claude-opus-5", "claude-fable-5", "claude-opus-4-8"]) {
    assert.equal(isForcedToolChoiceUnsupported(m), false, m);
  }
  const keep = sanitizeAnthropicRequest(
    req({ tool_choice: { type: "any" } }),
    "claude-opus-5",
  );
  assert.deepEqual(keep.tool_choice, { type: "any" });
});
