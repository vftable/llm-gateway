// thinking-signature hook tests: stripThinkingBlocks (lossy), thinkingBlocksToText
// (the non-lossy default), and normalizeThinkingSignatures (the Json-typed
// entry point wired into the request-hook stack).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripThinkingBlocks,
  thinkingBlocksToText,
  normalizeThinkingSignatures,
} from "./thinking-signature";
import { defaultAnthropicRequestHooks } from "./stack";
import type { TransformCtx } from "../../pipeline";

function ctx(over: Partial<TransformCtx> = {}): TransformCtx {
  return {
    provider: { id: "p" } as never,
    clientFmt: "messages",
    providerFmt: "messages",
    upstreamModel: "claude-opus-4-8",
    maxOutputTokens: null,
    ...over,
  };
}

// --- thinkingBlocksToText (non-lossy, the default) --------------------------

test("thinkingBlocksToText: a thinking block becomes a signature-free text block", () => {
  const body = {
    model: "m",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me think", signature: "sig-123" },
          { type: "text", text: "the answer" },
        ],
      },
    ],
  };
  const out = thinkingBlocksToText(body);
  const msgs = out.messages as Array<{
    content: Array<Record<string, unknown>>;
  }>;
  assert.deepEqual(msgs[0].content, [
    { type: "text", text: "let me think" },
    { type: "text", text: "the answer" },
  ]);
});

test("thinkingBlocksToText: preserves reasoning prose (not lossy)", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "the reasoning that must survive",
            signature: "llmapi-synthetic-thinking",
          },
        ],
      },
    ],
  };
  const out = thinkingBlocksToText(body);
  const msgs = out.messages as Array<{
    content: Array<Record<string, unknown>>;
  }>;
  assert.equal(msgs[0].content.length, 1);
  assert.equal(msgs[0].content[0].type, "text");
  assert.equal(msgs[0].content[0].text, "the reasoning that must survive");
  // No signature field survives onto a text block (text blocks have none).
  assert.equal("signature" in msgs[0].content[0], false);
});

test("thinkingBlocksToText: an empty/whitespace-only thinking block is dropped, not kept as empty text", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "thinking", thinking: "   \n  ", signature: "sig" },
          { type: "text", text: "answer" },
        ],
      },
    ],
  };
  const out = thinkingBlocksToText(body);
  const msgs = out.messages as Array<{
    content: Array<Record<string, unknown>>;
  }>;
  assert.deepEqual(msgs[0].content, [{ type: "text", text: "answer" }]);
});

test("thinkingBlocksToText: redacted_thinking blocks are always dropped (no readable text)", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "encrypted-blob" },
          { type: "text", text: "answer" },
        ],
      },
    ],
  };
  const out = thinkingBlocksToText(body);
  const msgs = out.messages as Array<{
    content: Array<Record<string, unknown>>;
  }>;
  assert.deepEqual(msgs[0].content, [{ type: "text", text: "answer" }]);
});

test("thinkingBlocksToText: non-thinking blocks pass through untouched", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hi" }],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "search", input: { q: "x" } },
        ],
      },
    ],
  };
  const out = thinkingBlocksToText(body);
  assert.deepEqual(out.messages, body.messages);
});

test("thinkingBlocksToText: a message with no thinking blocks is left as the SAME reference (untouched)", () => {
  const msg = { role: "user", content: [{ type: "text", text: "hi" }] };
  const body = { messages: [msg] };
  const out = thinkingBlocksToText(body);
  const msgs = out.messages as unknown[];
  assert.equal(msgs[0], msg); // reference equality — not rebuilt
});

test("thinkingBlocksToText: no messages array -> shallow copy, no throw", () => {
  const out = thinkingBlocksToText({ model: "m" });
  assert.deepEqual(out, { model: "m" });
});

test("thinkingBlocksToText: messages is not an array -> shallow copy, no throw", () => {
  const out = thinkingBlocksToText({ messages: "not-an-array" });
  assert.deepEqual(out, { messages: "not-an-array" });
});

test("thinkingBlocksToText: a message whose content is a bare string is left untouched (no content array to scan)", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };
  const out = thinkingBlocksToText(body);
  assert.deepEqual(out, body);
});

test("thinkingBlocksToText: multiple thinking blocks in one turn all convert, in order", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "first", signature: "s1" },
          { type: "text", text: "partial answer" },
          { type: "thinking", thinking: "second", signature: "s2" },
          { type: "text", text: "more answer" },
        ],
      },
    ],
  };
  const out = thinkingBlocksToText(body);
  const msgs = out.messages as Array<{
    content: Array<Record<string, unknown>>;
  }>;
  assert.deepEqual(msgs[0].content, [
    { type: "text", text: "first" },
    { type: "text", text: "partial answer" },
    { type: "text", text: "second" },
    { type: "text", text: "more answer" },
  ]);
});

// --- stripThinkingBlocks (lossy, opt-in only) -------------------------------

test("stripThinkingBlocks: drops thinking blocks entirely, no text substitute", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning", signature: "s1" },
          { type: "text", text: "answer" },
        ],
      },
    ],
  };
  const out = stripThinkingBlocks(body);
  const msgs = out.messages as Array<{
    content: Array<Record<string, unknown>>;
  }>;
  assert.deepEqual(msgs[0].content, [{ type: "text", text: "answer" }]);
});

// --- normalizeThinkingSignatures (Json entry point) -------------------------

test("normalizeThinkingSignatures delegates to thinkingBlocksToText (non-lossy)", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "keep me", signature: "s" }],
      },
    ],
  } as never;
  const out = normalizeThinkingSignatures(body);
  const msgs = out.messages as Array<{
    content: Array<Record<string, unknown>>;
  }>;
  assert.deepEqual(msgs[0].content, [{ type: "text", text: "keep me" }]);
});

// --- integration: wired into the stack, runs first, on every provider ------

test("stack: anthropic:thinking-signature is first and strips a real OR synthetic signature identically", () => {
  const hooks = defaultAnthropicRequestHooks();
  assert.equal(hooks[0].name, "anthropic:thinking-signature");

  const bodyWithRealSig = {
    model: "m",
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "genuine Anthropic reasoning",
            signature: "a-real-looking-cryptographic-signature==",
          },
        ],
      },
    ],
  };
  const out = hooks[0].apply(bodyWithRealSig, ctx()) as Record<string, unknown>;
  const msgs = out.messages as Array<{
    content: Array<Record<string, unknown>>;
  }>;
  // Converted to text regardless of whether the signature "looked real" — the
  // gateway can never prove ANY signature is valid for whatever provider this
  // hop is about to hit (see the module doc comment).
  assert.deepEqual(msgs[0].content, [
    { type: "text", text: "genuine Anthropic reasoning" },
  ]);
});

test("stack: anthropic:thinking-signature is a no-op when providerFmt isn't messages", () => {
  const hooks = defaultAnthropicRequestHooks();
  const hook = hooks.find((h) => h.name === "anthropic:thinking-signature")!;
  const body = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "keep", signature: "s" }],
      },
    ],
  };
  const out = hook.apply(body, ctx({ providerFmt: "chat" })) as Record<
    string,
    unknown
  >;
  assert.equal(out, body); // untouched passthrough
});

test("stack: thinking-signature runs BEFORE thinking-config, so thinking-config never sees a thinking block in content", () => {
  // Regression guard for hook ORDER: if thinking-signature ran after
  // thinking-config, a `thinking` content block would still be present when
  // thinking-config's structural checks run. This just asserts the observable
  // order-dependent behavior: content is already text-only by the second hook.
  const hooks = defaultAnthropicRequestHooks();
  let body: Record<string, unknown> = {
    model: "m",
    max_tokens: 4096,
    thinking: { type: "enabled", budget_tokens: 2000 },
    messages: [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "step 1", signature: "s" }],
      },
    ],
  };
  // Apply only the first hook (thinking-signature).
  body = hooks[0].apply(body, ctx()) as Record<string, unknown>;
  const msgs = body.messages as Array<{
    content: Array<Record<string, unknown>>;
  }>;
  assert.ok(msgs[0].content.every((b) => b.type !== "thinking"));
});
