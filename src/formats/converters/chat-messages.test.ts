// Conversion-quirk tests for the OpenAI Chat <-> Anthropic Messages bridge.
// Each test targets one documented quirk in docs/format-conversion.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "stream";
import {
  messagesRequestToChat,
  chatRequestToMessages,
  chatResponseToMessages,
  messagesResponseToChat,
  ChatToMessagesSseTransform,
  MessagesToChatSseTransform,
} from "./chat-messages";
import { SYNTHETIC_THINKING_SIGNATURE } from "../wire/anthropic";

// --- helpers ---------------------------------------------------------------

// Drive an SSE transform with a list of raw event strings and collect the
// emitted output as parsed data payloads (keyed by event where present).
function runSse(
  transform: ChatToMessagesSseTransform | MessagesToChatSseTransform,
  input: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const sink = new Writable({
      write(chunk, _enc, cb) {
        out += chunk.toString("utf8");
        cb();
      },
    });
    transform.pipe(sink);
    transform.on("error", reject);
    sink.on("finish", () => resolve(out));
    transform.end(Buffer.from(input, "utf8"));
  });
}

// Parse Anthropic SSE output into an ordered list of {event, data}.
function parseAnthropicSse(
  raw: string,
): Array<{ event: string; data: Record<string, unknown> }> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of raw.split("\n\n")) {
    if (!block.trim()) continue;
    let event = "";
    let dataStr = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataStr += line.slice(5).trimStart();
    }
    if (!dataStr) continue;
    try {
      events.push({ event, data: JSON.parse(dataStr) });
    } catch {
      /* skip */
    }
  }
  return events;
}

// Parse OpenAI chat SSE output into an ordered list of chunk objects.
function parseChatSse(raw: string): Array<Record<string, unknown>> {
  const chunks: Array<Record<string, unknown>> = [];
  for (const block of raw.split("\n\n")) {
    const line = block.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") continue;
    try {
      chunks.push(JSON.parse(payload));
    } catch {
      /* skip */
    }
  }
  return chunks;
}

// ===========================================================================
// R1 — tool-id sanitization (-> messages)
// ===========================================================================

test("R1: chat->messages sanitizes tool ids to Anthropic ^[A-Za-z0-9_-]+$", () => {
  const out = chatRequestToMessages({
    model: "m",
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call:abc/123",
            type: "function",
            function: { name: "get", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call:abc/123", content: "ok" },
    ],
  });
  const msgs = out.messages as Array<{ role: string; content: unknown }>;
  const toolUse = (msgs[0].content as Array<Record<string, unknown>>)[0];
  const toolResult = (msgs[1].content as Array<Record<string, unknown>>)[0];
  assert.match(toolUse.id as string, /^[a-zA-Z0-9_-]+$/);
  assert.match(toolResult.tool_use_id as string, /^[a-zA-Z0-9_-]+$/);
  // Same sanitized value on both sides so the pairing survives.
  assert.equal(toolUse.id, "callabc123");
  assert.equal(toolResult.tool_use_id, "callabc123");
});

// ===========================================================================
// R2 — missing tool-response insertion (-> chat)
// ===========================================================================

test("R2: messages->chat inserts a placeholder tool reply for an unanswered tool_use", () => {
  const out = messagesRequestToChat({
    model: "m",
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "search",
            input: { q: "x" },
          },
        ],
      },
      // No tool_result follows — OpenAI would 400 without a filler.
      { role: "user", content: "thanks" },
    ],
  });
  const msgs = out.messages as Array<{
    role: string;
    tool_call_id?: string;
    content?: unknown;
  }>;
  const toolMsg = msgs.find((m) => m.role === "tool");
  assert.ok(toolMsg, "expected an inserted tool message");
  assert.equal(toolMsg!.tool_call_id, "toolu_1");
  assert.equal(toolMsg!.content, "[No response received]");
  // Ordered right after the assistant, before the trailing user message.
  assert.equal(msgs[0].role, "assistant");
  assert.equal(msgs[1].role, "tool");
  assert.equal(msgs[2].role, "user");
});

test("R2: a tool_use that IS answered gets no filler", () => {
  const out = messagesRequestToChat({
    model: "m",
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "s", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "done" },
        ],
      },
    ],
  });
  const msgs = out.messages as Array<{ role: string; content?: unknown }>;
  const toolMsgs = msgs.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 1);
  assert.equal(toolMsgs[0].content as string, "done");
});

// ===========================================================================
// R3 — response_format -> system instruction (-> messages)
// ===========================================================================

test("R3: chat->messages turns json_object into a system instruction", () => {
  const out = chatRequestToMessages({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    response_format: { type: "json_object" },
  });
  assert.match(out.system as string, /valid JSON/i);
});

test("R3: chat->messages embeds a json_schema into the system instruction", () => {
  const schema = { type: "object", properties: { a: { type: "number" } } };
  const out = chatRequestToMessages({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    response_format: { type: "json_schema", json_schema: { schema } },
  });
  const sys = out.system as string;
  assert.match(sys, /JSON schema/i);
  assert.match(sys, /"properties"/);
});

// ===========================================================================
// R4 — OpenAI file block -> Claude document (PDF only)
// ===========================================================================

test("R4: chat->messages maps a PDF file block to a document block", () => {
  const out = chatRequestToMessages({
    model: "m",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "read this" },
          {
            type: "file",
            file: { file_data: "data:application/pdf;base64,QUJD" },
          },
        ],
      },
    ],
  });
  const blocks = (
    out.messages as Array<{ content: Array<Record<string, unknown>> }>
  )[0].content;
  const doc = blocks.find((b) => b.type === "document");
  assert.ok(doc, "expected a document block");
  const src = doc!.source as Record<string, unknown>;
  assert.equal(src.type, "base64");
  assert.equal(src.media_type, "application/pdf");
  assert.equal(src.data, "QUJD");
});

test("R4: a non-PDF file block is dropped, not sent", () => {
  const out = chatRequestToMessages({
    model: "m",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "x" },
          { type: "file", file: { file_data: "data:text/plain;base64,QQ==" } },
        ],
      },
    ],
  });
  const blocks = (
    out.messages as Array<{ content: Array<Record<string, unknown>> }>
  )[0].content;
  assert.ok(!blocks.some((b) => b.type === "document"));
});

// ===========================================================================
// R7 — max_tokens default (-> messages)
// ===========================================================================

test("R7: chat->messages defaults max_tokens when absent", () => {
  const out = chatRequestToMessages({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(typeof out.max_tokens, "number");
  assert.equal(out.max_tokens, 4096);
});

test("R7: max_completion_tokens is honored as a source", () => {
  const out = chatRequestToMessages({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    max_completion_tokens: 1234,
  });
  assert.equal(out.max_tokens, 1234);
});

// ===========================================================================
// R9 — temperature range reconciliation (OpenAI 0–2 -> Anthropic 0–1)
// ===========================================================================

test("R9: chat->messages clamps temperature above 1.0 to 1.0 (Anthropic max)", () => {
  const out = chatRequestToMessages({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    temperature: 1.5,
  });
  assert.equal(out.temperature, 1);
});

test("R9: an in-range temperature is passed through unchanged", () => {
  const out = chatRequestToMessages({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.4,
  });
  assert.equal(out.temperature, 0.4);
});

test("R9: a negative temperature is clamped up to 0", () => {
  const out = chatRequestToMessages({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    temperature: -0.2,
  });
  assert.equal(out.temperature, 0);
});

// ===========================================================================
// R8 — reasoning-effort passthrough
// ===========================================================================

test("R8: chat->messages carries reasoning_effort as output_config.effort", () => {
  const out = chatRequestToMessages({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "high",
  });
  assert.deepEqual(out.output_config, { effort: "high" });
  assert.equal(out.reasoning, undefined);
});

test("R8: messages->chat carries output_config.effort as reasoning_effort", () => {
  const out = messagesRequestToChat({
    model: "m",
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    output_config: { effort: "low" },
  });
  assert.equal(out.reasoning_effort, "low");
});

test("R8: messages->chat falls back to legacy reasoning.effort for compat", () => {
  const out = messagesRequestToChat({
    model: "m",
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    reasoning: { effort: "medium" },
  } as Record<string, unknown>);
  assert.equal(out.reasoning_effort, "medium");
});

test("R8: messages->chat converts thinking.type:adaptive to reasoning_effort", () => {
  const out = messagesRequestToChat({
    model: "m",
    max_tokens: 8192,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "adaptive" },
  });
  assert.equal(out.reasoning_effort, "high");
});

test("R8: messages->chat converts thinking budget_tokens to effort level", () => {
  const out = messagesRequestToChat({
    model: "m",
    max_tokens: 8192,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "enabled", budget_tokens: 24576 },
  });
  assert.equal(out.reasoning_effort, "high");

  const out2 = messagesRequestToChat({
    model: "m",
    max_tokens: 8192,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "enabled", budget_tokens: 2048 },
  });
  assert.equal(out2.reasoning_effort, "low");
});

test("R8: output_config.effort takes priority over thinking.type", () => {
  const out = messagesRequestToChat({
    model: "m",
    max_tokens: 8192,
    messages: [{ role: "user", content: "hi" }],
    output_config: { effort: "low" },
    thinking: { type: "adaptive" },
  });
  assert.equal(out.reasoning_effort, "low");
});

test("R8: thinking.type:disabled does not produce reasoning_effort", () => {
  const out = messagesRequestToChat({
    model: "m",
    max_tokens: 8192,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "disabled" },
  });
  assert.equal(out.reasoning_effort, undefined);
});

// ===========================================================================
// S1 — thinking <-> reasoning_content (buffered)
// ===========================================================================

test("S1: messages->chat maps a thinking block to reasoning_content", () => {
  const out = messagesResponseToChat({
    id: "msg_1",
    model: "m",
    content: [
      { type: "thinking", thinking: "let me think" },
      { type: "text", text: "answer" },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 5 },
  });
  const msg = (out.choices as Array<{ message: Record<string, unknown> }>)[0]
    .message;
  assert.equal(msg.reasoning_content, "let me think");
  assert.equal(msg.content, "answer");
});

test("S1: chat->messages maps reasoning_content to a leading thinking block", () => {
  const out = chatResponseToMessages({
    id: "chatcmpl_1",
    model: "m",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "answer",
          reasoning_content: "hmm",
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 5 },
  });
  const blocks = out.content as Array<Record<string, unknown>>;
  assert.equal(blocks[0].type, "thinking");
  assert.equal(blocks[0].thinking, "hmm");
  assert.equal(blocks[1].type, "text");
});

// ===========================================================================
// S2 — cache-token accounting (buffered)
// ===========================================================================

test("S2: messages->chat folds cache tokens into prompt_tokens + details", () => {
  const out = messagesResponseToChat({
    id: "msg_1",
    model: "m",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 6,
      cache_creation_input_tokens: 2,
    },
  });
  const usage = out.usage as {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_creation_tokens?: number;
    };
  };
  // prompt = input + cache_read + cache_creation = 18
  assert.equal(usage.prompt_tokens, 18);
  assert.equal(usage.completion_tokens, 4);
  assert.equal(usage.total_tokens, 22);
  assert.equal(usage.prompt_tokens_details?.cached_tokens, 6);
  assert.equal(usage.prompt_tokens_details?.cache_creation_tokens, 2);
});

test("S2: chat->messages subtracts folded cache tokens back out of input_tokens", () => {
  const out = chatResponseToMessages({
    id: "chatcmpl_1",
    model: "m",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hi" },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 18,
      completion_tokens: 4,
      prompt_tokens_details: { cached_tokens: 6, cache_creation_tokens: 2 },
    },
  });
  const usage = out.usage as {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  // input = prompt - cached - cache_creation = 10
  assert.equal(usage.input_tokens, 10);
  assert.equal(usage.output_tokens, 4);
  assert.equal(usage.cache_read_input_tokens, 6);
  assert.equal(usage.cache_creation_input_tokens, 2);
});

// ===========================================================================
// S1/S2 — streaming
// ===========================================================================

test("S1 streaming: chat reasoning_content -> Anthropic thinking events", async () => {
  const input =
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "th" } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } })}\n\n` +
    `data: [DONE]\n\n`;
  const events = parseAnthropicSse(
    await runSse(new ChatToMessagesSseTransform("m"), input),
  );
  // A thinking block opens, gets a thinking_delta, then a text block follows.
  const thinkingStart = events.find(
    (e) =>
      e.event === "content_block_start" &&
      (e.data.content_block as { type?: string })?.type === "thinking",
  );
  assert.ok(thinkingStart, "expected a thinking content_block_start");
  const thinkingDelta = events.find(
    (e) =>
      e.event === "content_block_delta" &&
      (e.data.delta as { type?: string })?.type === "thinking_delta",
  );
  assert.equal(
    (thinkingDelta!.data.delta as { thinking: string }).thinking,
    "th",
  );
});

test("S1 streaming: Anthropic thinking_delta -> chat reasoning_content", async () => {
  const input =
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5 } } })}\n\n` +
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reason" } })}\n\n` +
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } })}\n\n` +
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
  const chunks = parseChatSse(
    await runSse(new MessagesToChatSseTransform("m"), input),
  );
  const rc = chunks.find(
    (c) =>
      (c.choices as Array<{ delta?: { reasoning_content?: string } }>)[0]?.delta
        ?.reasoning_content === "reason",
  );
  assert.ok(rc, "expected a reasoning_content delta");
});

test("S2 streaming: Anthropic cache usage merges start+delta into chat usage", async () => {
  const input =
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 6 } } })}\n\n` +
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}\n\n` +
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } })}\n\n` +
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
  const chunks = parseChatSse(
    await runSse(new MessagesToChatSseTransform("m"), input),
  );
  const last = chunks[chunks.length - 1];
  const usage = last.usage as {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  // prompt = input(10) + cache_read(6) = 16, output captured from delta.
  assert.equal(usage.prompt_tokens, 16);
  assert.equal(usage.completion_tokens, 4);
  assert.equal(usage.prompt_tokens_details?.cached_tokens, 6);
});

// ===========================================================================
// Streaming tool calls — per the format-route completeness audit, the
// buffered tool_use<->tool_calls mapping (R1/R2/round-trip above) was tested,
// but the STREAMING half (delta-by-delta) had zero coverage despite being
// fully implemented.
// ===========================================================================

test("streaming tool calls: chat tool_calls deltas -> Anthropic tool_use content block + input_json_delta", async () => {
  const input =
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search", arguments: "" } }] } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n` +
    `data: [DONE]\n\n`;
  const events = parseAnthropicSse(
    await runSse(new ChatToMessagesSseTransform("m"), input),
  );
  const toolStart = events.find(
    (e) =>
      e.event === "content_block_start" &&
      (e.data.content_block as { type?: string })?.type === "tool_use",
  );
  assert.ok(toolStart, "expected a tool_use content_block_start");
  const block = toolStart!.data.content_block as {
    id: string;
    name: string;
  };
  assert.equal(block.id, "call_1");
  assert.equal(block.name, "search");

  const jsonDeltas = events.filter(
    (e) =>
      e.event === "content_block_delta" &&
      (e.data.delta as { type?: string })?.type === "input_json_delta",
  );
  const assembled = jsonDeltas
    .map((e) => (e.data.delta as { partial_json: string }).partial_json)
    .join("");
  assert.equal(assembled, '{"q":"x"}');

  // The tool_use block must be closed (content_block_stop) once the turn
  // finishes, same as a text/thinking block.
  const stopIndices = events
    .filter((e) => e.event === "content_block_stop")
    .map((e) => e.data.index);
  assert.ok(stopIndices.includes(toolStart!.data.index));
});

test("streaming tool calls: multiple concurrent tool_calls stay on separate content blocks by index", async () => {
  const input =
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_a",
                function: { name: "search", arguments: "" },
              },
              {
                index: 1,
                id: "call_b",
                function: { name: "fetch", arguments: "" },
              },
            ],
          },
        },
      ],
    })}\n\n` +
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 1, function: { arguments: "b-args" } },
              { index: 0, function: { arguments: "a-args" } },
            ],
          },
        },
      ],
    })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n` +
    `data: [DONE]\n\n`;
  const events = parseAnthropicSse(
    await runSse(new ChatToMessagesSseTransform("m"), input),
  );
  const starts = events.filter(
    (e) =>
      e.event === "content_block_start" &&
      (e.data.content_block as { type?: string })?.type === "tool_use",
  );
  assert.equal(starts.length, 2);
  const byName = new Map(
    starts.map((e) => [
      (e.data.content_block as { name: string }).name,
      e.data.index,
    ]),
  );
  const searchIndex = byName.get("search");
  const fetchIndex = byName.get("fetch");
  assert.notEqual(searchIndex, fetchIndex);

  // Each block's json_delta must land on ITS OWN index, not cross-contaminate.
  const deltaFor = (idx: unknown) =>
    events
      .filter(
        (e) =>
          e.event === "content_block_delta" &&
          e.data.index === idx &&
          (e.data.delta as { type?: string })?.type === "input_json_delta",
      )
      .map((e) => (e.data.delta as { partial_json: string }).partial_json)
      .join("");
  assert.equal(deltaFor(searchIndex), "a-args");
  assert.equal(deltaFor(fetchIndex), "b-args");
});

test("streaming tool calls: Anthropic tool_use content block + input_json_delta -> chat tool_calls deltas", async () => {
  const input =
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5 } } })}\n\n` +
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "search", input: {} } })}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"q":' } })}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"x"}' } })}\n\n` +
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } })}\n\n` +
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
  const chunks = parseChatSse(
    await runSse(new MessagesToChatSseTransform("m"), input),
  );

  const opening = chunks.find(
    (c) =>
      (
        c.choices as Array<{ delta?: { tool_calls?: Array<{ id?: string }> } }>
      )[0]?.delta?.tool_calls?.[0]?.id,
  );
  assert.ok(opening, "expected an opening tool_calls chunk with the id");
  const openingCall = (
    opening!.choices as Array<{
      delta: {
        tool_calls: Array<{ id?: string; function?: { name?: string } }>;
      };
    }>
  )[0].delta.tool_calls[0];
  assert.equal(openingCall.id, "toolu_1");
  assert.equal(openingCall.function?.name, "search");

  const argDeltas = chunks
    .flatMap(
      (c) =>
        (
          c.choices as Array<{
            delta?: {
              tool_calls?: Array<{ function?: { arguments?: string } }>;
            };
          }>
        )[0]?.delta?.tool_calls ?? [],
    )
    .map((tc) => tc.function?.arguments)
    .filter((a): a is string => !!a);
  assert.equal(argDeltas.join(""), '{"q":"x"}');
});

// ===========================================================================
// Round-trip smoke: a chat request with tools survives chat->messages->chat
// ===========================================================================

test("round-trip: assistant tool_calls survive chat->messages", () => {
  const out = chatRequestToMessages({
    model: "m",
    messages: [
      { role: "user", content: "call it" },
      {
        role: "assistant",
        content: "sure",
        tool_calls: [
          {
            id: "toolu_a",
            type: "function",
            function: { name: "f", arguments: '{"x":1}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "toolu_a", content: "42" },
    ],
  });
  const msgs = out.messages as Array<{ role: string; content: unknown }>;
  // assistant turn keeps text + tool_use; tool result becomes a user turn.
  const assistant = msgs.find((m) => m.role === "assistant")!;
  const blocks = assistant.content as Array<Record<string, unknown>>;
  assert.ok(blocks.some((b) => b.type === "text"));
  assert.ok(blocks.some((b) => b.type === "tool_use"));
});

// ===========================================================================
// C — Anthropic schema conformance (structural rules ported from 9router)
// ===========================================================================

test("C1: developer role folds into the Anthropic system field", () => {
  const out = chatRequestToMessages({
    model: "m",
    messages: [
      { role: "developer", content: "be terse" },
      { role: "system", content: "you are X" },
      { role: "user", content: "hi" },
    ],
  });
  const sys = out.system as string;
  assert.match(sys, /be terse/);
  assert.match(sys, /you are X/);
  // No developer/system turn leaks into messages[].
  const msgs = out.messages as Array<{ role: string }>;
  assert.ok(msgs.every((m) => m.role === "user" || m.role === "assistant"));
});

test("C2: consecutive same-role turns are merged (strict alternation)", () => {
  const out = chatRequestToMessages({
    model: "m",
    messages: [
      { role: "user", content: "part one" },
      { role: "user", content: "part two" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },
    ],
  });
  const msgs = out.messages as Array<{ role: string; content: unknown }>;
  // user, assistant — two turns, no adjacent duplicates.
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant"],
  );
  const userBlocks = msgs[0].content as Array<{ type: string; text?: string }>;
  assert.equal(userBlocks.filter((b) => b.type === "text").length, 2);
});

test("C3: text after tool_use in an assistant turn is dropped", () => {
  const out = chatRequestToMessages({
    model: "m",
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "before" },
          { type: "tool_use", id: "toolu_1", name: "f", input: {} },
          { type: "text", text: "AFTER should be dropped" },
        ],
      },
      { role: "tool", tool_call_id: "toolu_1", content: "ok" },
    ],
  });
  const msgs = out.messages as Array<{ role: string; content: unknown }>;
  const asst = msgs.find((m) => m.role === "assistant")!;
  const texts = (asst.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text);
  assert.deepEqual(texts, ["before"]);
});

test("C4: tool_result blocks sort before other content in a merged user turn", () => {
  // An assistant tool_use, then a user turn carrying both a tool_result and text.
  const out = chatRequestToMessages({
    model: "m",
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "f", input: {} }],
      },
      { role: "tool", tool_call_id: "toolu_1", content: "result" },
      { role: "user", content: "and here is more" },
    ],
  });
  const msgs = out.messages as Array<{ role: string; content: unknown }>;
  // The tool turn + following user turn merge into ONE user turn,
  // tool_result first.
  const userTurn = msgs[msgs.length - 1];
  assert.equal(userTurn.role, "user");
  const blocks = userTurn.content as Array<{ type: string }>;
  assert.equal(blocks[0].type, "tool_result");
  assert.ok(blocks.some((b) => b.type === "text"));
});

test("C5: field mapping stop->stop_sequences, top_k, user->metadata.user_id", () => {
  const out = chatRequestToMessages({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    stop: ["STOP", "END"],
    top_k: 40,
    user: "user-123",
  });
  assert.deepEqual(out.stop_sequences, ["STOP", "END"]);
  assert.equal(out.top_k, 40);
  assert.deepEqual(out.metadata, { user_id: "user-123" });
});

test("C5b: a scalar stop string becomes a one-element stop_sequences", () => {
  const out = chatRequestToMessages({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    stop: "DONE",
  });
  assert.deepEqual(out.stop_sequences, ["DONE"]);
});

test("C6: messages->chat does NOT map metadata.user_id to user", () => {
  const out = messagesRequestToChat({
    model: "m",
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    metadata: { user_id: "u-9" },
    top_k: 5,
  });
  assert.equal(out.user, undefined);
  assert.equal(out.top_k, 5);
});

// --- synthetic thinking-block signature (buffered + streaming) -------------
// Every thinking block the gateway SYNTHESIZES from an OpenAI-shaped
// reasoning source must carry SYNTHETIC_THINKING_SIGNATURE so its shape
// matches a real Anthropic thinking block (some clients/SDKs reject one with
// no signature at all on echo-back). See wire/anthropic.ts's doc comment.

test("chatResponseToMessages: a synthesized thinking block carries the synthetic signature", () => {
  const out = chatResponseToMessages({
    id: "cc1",
    model: "m",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "answer",
          reasoning_content: "plan",
        },
        finish_reason: "stop",
      },
    ],
  });
  const thinking = out.content!.find(
    (b) => (b as { type?: string }).type === "thinking",
  ) as { thinking?: string; signature?: string };
  assert.equal(thinking.thinking, "plan");
  assert.equal(thinking.signature, SYNTHETIC_THINKING_SIGNATURE);
});

test("chatResponseToMessages: no reasoning_content -> no thinking block emitted at all (not an empty one)", () => {
  const out = chatResponseToMessages({
    id: "cc2",
    model: "m",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "answer" },
        finish_reason: "stop",
      },
    ],
  });
  assert.ok(
    !out.content!.some((b) => (b as { type?: string }).type === "thinking"),
  );
});

test("streaming (chat->messages): a synthesized thinking block emits signature_delta before content_block_stop", async () => {
  const input =
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "plan" } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { content: "answer" } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
    `data: [DONE]\n\n`;
  const events = parseAnthropicSse(
    await runSse(new ChatToMessagesSseTransform("m"), input),
  );
  const thinkingStart = events.findIndex(
    (e) =>
      e.event === "content_block_start" &&
      (e.data.content_block as { type?: string })?.type === "thinking",
  );
  const sigDeltaIdx = events.findIndex(
    (e) =>
      e.event === "content_block_delta" &&
      (e.data.delta as { type?: string })?.type === "signature_delta",
  );
  const stopIdx = events.findIndex(
    (e, i) => i > thinkingStart && e.event === "content_block_stop",
  );
  assert.ok(sigDeltaIdx !== -1, "expected a signature_delta event");
  assert.equal(
    (events[sigDeltaIdx].data.delta as { signature: string }).signature,
    SYNTHETIC_THINKING_SIGNATURE,
  );
  assert.ok(
    thinkingStart < sigDeltaIdx && sigDeltaIdx < stopIdx,
    "expected order: start < signature_delta < stop",
  );
});

test("streaming (chat->messages): no reasoning at all -> no thinking block, no signature_delta", async () => {
  const input =
    `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
    `data: [DONE]\n\n`;
  const events = parseAnthropicSse(
    await runSse(new ChatToMessagesSseTransform("m"), input),
  );
  assert.ok(
    !events.some(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as { type?: string })?.type === "thinking",
    ),
  );
  assert.ok(
    !events.some(
      (e) =>
        e.event === "content_block_delta" &&
        (e.data.delta as { type?: string })?.type === "signature_delta",
    ),
  );
});
