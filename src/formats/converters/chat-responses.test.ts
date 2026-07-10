// chat<->responses converter round-trip tests (regression guard for the
// wire-type retype).
//
// The converter translates a Responses-shaped request to Chat Completions, and
// a Chat Completions response back to Responses. These assert the fields it
// actually maps survive the retype to shared wire types (no behavior change).
//
// Also covers BOTH streaming directions:
//   - StreamingResponsesBridgeTransform       (chat SSE -> responses SSE) —
//     had ZERO test coverage before this per the format-route completeness
//     audit, despite being fully implemented (the module doc comment even
//     used to claim "streaming is a separate piece of work").
//   - StreamingResponsesToChatBridgeTransform (responses SSE -> chat SSE) —
//     the new inverse, added so a chat/messages client can be routed to a
//     responses-native provider (see pipeline.ts's "chat->responses"/
//     "messages->responses" request converters and "responses->chat"/
//     "responses->messages" response/stream converters, which route
//     through these).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Transform } from "stream";
import {
  responsesRequestToChat,
  chatRequestToResponses,
  chatResponseToResponses,
  responsesResponseToChat,
  StreamingResponsesBridgeTransform,
  StreamingResponsesToChatBridgeTransform,
} from "./chat-responses";
import type {
  ResponsesRequest,
  ResponsesResponse,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "../wire";

// Feed a Buffer[] of raw SSE bytes through a Transform stream and collect the
// full output as a single string, resolving once the stream ends.
function runTransform(t: Transform, chunks: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    t.on("data", (c: Buffer) => out.push(c));
    t.on("end", () => resolve(Buffer.concat(out).toString("utf8")));
    t.on("error", reject);
    for (const c of chunks) t.write(Buffer.from(c, "utf8"));
    t.end();
  });
}

// Parse a chat-shaped SSE stream (data: {...}\n\n / data: [DONE]\n\n) into an
// array of parsed chunk objects (dropping the [DONE] sentinel).
function parseChatSse(raw: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const frame of raw.split("\n\n")) {
    const line = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    out.push(JSON.parse(data));
  }
  return out;
}

// A Responses SSE frame, in the shape the (forward) bridge's pushSse() emits.
function responsesSseFrame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// A Chat Completions SSE frame (the shape a real chat-native upstream emits).
function chatSseFrame(chunk: Record<string, unknown>): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// Parse the Responses-shaped SSE the forward bridge emits into an ordered
// list of parsed events (each `{ type, ... }`).
function parseResponsesSse(raw: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const frame of raw.split("\n\n")) {
    const line = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    out.push(JSON.parse(data));
  }
  return out;
}

// --- request: Responses -> Chat --------------------------------------------

test("request: instructions -> system message, string input -> user message", () => {
  const req: ResponsesRequest = {
    model: "gpt-x",
    instructions: "be terse",
    input: "hello",
  };
  const chat = responsesRequestToChat(req);
  assert.equal(chat.model, "gpt-x");
  assert.deepEqual(chat.messages, [
    { role: "system", content: "be terse" },
    { role: "user", content: "hello" },
  ]);
});

test("request: max_output_tokens -> max_completion_tokens, reasoning.effort -> flat", () => {
  const chat = responsesRequestToChat({
    model: "m",
    input: "hi",
    max_output_tokens: 512,
    reasoning: { effort: "high" },
  });
  assert.equal(chat.max_completion_tokens, 512);
  assert.equal(chat.reasoning_effort, "high");
});

test("request: function tools translate; hosted tools are dropped", () => {
  const chat = responsesRequestToChat({
    model: "m",
    input: "hi",
    tools: [
      { type: "function", name: "get_weather", parameters: { type: "object" } },
      { type: "web_search" }, // hosted — not expressible in Chat, dropped
    ],
  });
  assert.equal(chat.tools?.length, 1);
  assert.equal(chat.tools?.[0].function.name, "get_weather");
});

test("request: item-array input with a function_call groups into tool_calls", () => {
  const chat = responsesRequestToChat({
    model: "m",
    input: [
      { type: "message", role: "user", content: "search it" },
      {
        type: "function_call",
        call_id: "c1",
        name: "search",
        arguments: '{"q":"x"}',
      },
    ],
  });
  const msgs = chat.messages!;
  assert.equal(msgs[0].role, "user");
  const asst = msgs.find((m) => m.role === "assistant")!;
  assert.equal(asst.tool_calls?.[0].id, "c1");
  assert.equal(asst.tool_calls?.[0].function.name, "search");
});

// --- response: Chat -> Responses -------------------------------------------

test("response: a plain assistant message -> a message output item", () => {
  const chat: ChatCompletionResponse = {
    id: "cc1",
    model: "m",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hi there" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  };
  const resp = chatResponseToResponses(chat)!;
  assert.equal(resp.object, "response");
  assert.equal(resp.status, "completed");
  const msg = resp.output!.find((o) => o.type === "message")!;
  assert.ok(msg);
  assert.equal(resp.usage?.input_tokens, 3);
  assert.equal(resp.usage?.output_tokens, 2);
});

test("response: reasoning_details -> a reasoning output item before the message", () => {
  const chat: ChatCompletionResponse = {
    id: "cc2",
    model: "m",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "answer",
          reasoning_details: [
            {
              type: "reasoning.text",
              text: "let me think",
              format: "unknown",
              index: 0,
            },
          ],
        },
        finish_reason: "stop",
      },
    ],
  };
  const resp = chatResponseToResponses(chat)!;
  assert.equal(resp.output![0].type, "reasoning");
  assert.equal(resp.output![0].summary?.[0].text, "let me think");
});

test("response: tool_calls -> function_call output items", () => {
  const chat: ChatCompletionResponse = {
    id: "cc3",
    model: "m",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "t1",
              type: "function",
              function: { name: "search", arguments: '{"q":"x"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
  const resp = chatResponseToResponses(chat)!;
  const fc = resp.output!.find((o) => o.type === "function_call")!;
  assert.equal(fc.name, "search");
  assert.equal(fc.call_id, "t1");
});

test("response: no first choice -> null", () => {
  assert.equal(chatResponseToResponses({ choices: [] }), null);
});

// --- request (inverse): Chat -> Responses -----------------------------------
// Lets a chat/messages CLIENT be routed to a responses-native provider.

test("request (inverse): a leading system message -> instructions, rest -> input items", () => {
  const chat: ChatCompletionRequest = {
    model: "gpt-x",
    messages: [
      { role: "system", content: "be terse" },
      { role: "user", content: "hello" },
    ],
  };
  const resp = chatRequestToResponses(chat);
  assert.equal(resp.model, "gpt-x");
  assert.equal(resp.instructions, "be terse");
  assert.equal((resp.input as unknown[]).length, 1);
  const item = (resp.input as Array<Record<string, unknown>>)[0];
  assert.equal(item.type, "message");
  assert.equal(item.role, "user");
});

test("request (inverse): max_completion_tokens -> max_output_tokens, reasoning_effort -> nested", () => {
  const resp = chatRequestToResponses({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    max_completion_tokens: 512,
    reasoning_effort: "high",
  });
  assert.equal(resp.max_output_tokens, 512);
  assert.equal((resp.reasoning as { effort?: unknown })?.effort, "high");
});

test("request (inverse): function tools translate to Responses' internally-tagged shape", () => {
  const resp = chatRequestToResponses({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        function: { name: "get_weather", parameters: { type: "object" } },
      },
    ],
  });
  assert.equal(resp.tools?.length, 1);
  assert.equal((resp.tools![0] as Record<string, unknown>).type, "function");
  assert.equal((resp.tools![0] as Record<string, unknown>).name, "get_weather");
});

test("request (inverse): an assistant message with tool_calls -> one function_call item per call", () => {
  const resp = chatRequestToResponses({
    model: "m",
    messages: [
      { role: "user", content: "search it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "search", arguments: '{"q":"x"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: '{"result":"ok"}' },
    ],
  });
  const items = resp.input as Array<Record<string, unknown>>;
  const fc = items.find((i) => i.type === "function_call")!;
  assert.equal(fc.call_id, "c1");
  assert.equal(fc.name, "search");
  const fco = items.find((i) => i.type === "function_call_output")!;
  assert.equal(fco.call_id, "c1");
  assert.equal(fco.output, '{"result":"ok"}');
});

test("request (inverse) round-trips with the forward direction (Responses -> Chat -> Responses)", () => {
  const original: ResponsesRequest = {
    model: "gpt-x",
    instructions: "be terse",
    input: "hello",
    max_output_tokens: 256,
  };
  const chat = responsesRequestToChat(original);
  const back = chatRequestToResponses(chat);
  assert.equal(back.model, "gpt-x");
  assert.equal(back.instructions, "be terse");
  assert.equal(back.max_output_tokens, 256);
});

// --- response (inverse): Responses -> Chat ----------------------------------

test("response (inverse): a message output item -> an assistant chat message", () => {
  const resp: ResponsesResponse = {
    id: "r1",
    model: "m",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hi there" }],
      },
    ],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  };
  const chat = responsesResponseToChat(resp)!;
  assert.equal(chat.choices?.[0].message?.role, "assistant");
  assert.equal(chat.choices?.[0].message?.content, "hi there");
  assert.equal(chat.choices?.[0].finish_reason, "stop");
  assert.equal(chat.usage?.prompt_tokens, 3);
  assert.equal(chat.usage?.completion_tokens, 2);
});

test("response (inverse): a reasoning output item -> reasoning_details on the message", () => {
  const resp: ResponsesResponse = {
    id: "r2",
    model: "m",
    status: "completed",
    output: [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "let me think" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "answer" }],
      },
    ],
  };
  const chat = responsesResponseToChat(resp)!;
  const details = chat.choices?.[0].message?.reasoning_details;
  assert.equal(details?.[0]?.type, "reasoning.text");
  assert.equal(details?.[0]?.text, "let me think");
});

test("response (inverse): a function_call output item -> tool_calls + finish_reason:'tool_calls'", () => {
  const resp: ResponsesResponse = {
    id: "r3",
    model: "m",
    status: "completed",
    output: [
      {
        type: "function_call",
        call_id: "t1",
        name: "search",
        arguments: '{"q":"x"}',
      },
    ],
  };
  const chat = responsesResponseToChat(resp)!;
  assert.equal(chat.choices?.[0].finish_reason, "tool_calls");
  assert.equal(
    chat.choices?.[0].message?.tool_calls?.[0].function.name,
    "search",
  );
});

test("response (inverse): status 'incomplete' -> finish_reason 'length'", () => {
  const resp: ResponsesResponse = {
    id: "r4",
    model: "m",
    status: "incomplete",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "cut off" }],
      },
    ],
  };
  const chat = responsesResponseToChat(resp)!;
  assert.equal(chat.choices?.[0].finish_reason, "length");
});

test("response (inverse) round-trips with the forward direction (Chat -> Responses -> Chat)", () => {
  const original: ChatCompletionResponse = {
    id: "cc1",
    model: "m",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hi there" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  };
  const responses = chatResponseToResponses(original)!;
  const back = responsesResponseToChat(responses)!;
  assert.equal(back.choices?.[0].message?.content, "hi there");
  assert.equal(back.choices?.[0].finish_reason, "stop");
  assert.equal(back.usage?.prompt_tokens, 3);
  assert.equal(back.usage?.completion_tokens, 2);
});

test("response (inverse): empty output -> a valid (empty-content) message, not null", () => {
  // Mirrors choiceToOutput's own philosophy on the forward side ("keep an
  // empty-content message so output is never empty") — an empty `output`
  // array is a legitimate (if unusual) response, not a malformed one, so it
  // must not be discarded outright (that would silently drop id/model/usage
  // too).
  const chat = responsesResponseToChat({ output: [] } as ResponsesResponse);
  assert.ok(chat);
  assert.equal(chat!.choices?.[0].message?.content, null);
  assert.equal(chat!.choices?.[0].finish_reason, "stop");
});

test("response (inverse): a missing/non-object body -> null", () => {
  assert.equal(
    responsesResponseToChat(undefined as unknown as ResponsesResponse),
    null,
  );
  assert.equal(
    responsesResponseToChat(null as unknown as ResponsesResponse),
    null,
  );
});

// --- streaming (inverse): Responses SSE -> Chat SSE -------------------------

test("streaming (inverse): output_text deltas -> chat content deltas, terminated by [DONE]", async () => {
  const raw = await runTransform(
    new StreamingResponsesToChatBridgeTransform(),
    [
      responsesSseFrame({
        type: "response.created",
        response: { id: "resp_1", model: "m", created_at: 100 },
      }),
      responsesSseFrame({
        type: "response.output_text.delta",
        delta: "Hel",
      }),
      responsesSseFrame({
        type: "response.output_text.delta",
        delta: "lo",
      }),
      responsesSseFrame({
        type: "response.completed",
        response: { id: "resp_1", status: "completed", output: [] },
      }),
    ],
  );
  assert.ok(raw.includes("data: [DONE]"));
  const chunks = parseChatSse(raw);
  const contentDeltas = chunks
    .map(
      (c) =>
        (c.choices as Array<{ delta?: { content?: string } }>)?.[0]?.delta
          ?.content,
    )
    .filter((c): c is string => !!c);
  assert.deepEqual(contentDeltas, ["Hel", "lo"]);
  const last = chunks[chunks.length - 1];
  assert.equal(
    (last.choices as Array<{ finish_reason?: string }>)[0].finish_reason,
    "stop",
  );
});

test("streaming (inverse): reasoning_text deltas -> chat reasoning_content deltas", async () => {
  const raw = await runTransform(
    new StreamingResponsesToChatBridgeTransform(),
    [
      responsesSseFrame({
        type: "response.created",
        response: { id: "resp_2", model: "m", created_at: 100 },
      }),
      responsesSseFrame({
        type: "response.reasoning_text.delta",
        delta: "thinking...",
      }),
      responsesSseFrame({
        type: "response.completed",
        response: { id: "resp_2", status: "completed", output: [] },
      }),
    ],
  );
  const chunks = parseChatSse(raw);
  const reasoningDeltas = chunks
    .map(
      (c) =>
        (c.choices as Array<{ delta?: { reasoning_content?: string } }>)?.[0]
          ?.delta?.reasoning_content,
    )
    .filter((c): c is string => !!c);
  assert.deepEqual(reasoningDeltas, ["thinking..."]);
});

test("streaming (inverse): function_call output item + argument deltas -> chat tool_calls deltas", async () => {
  const raw = await runTransform(
    new StreamingResponsesToChatBridgeTransform(),
    [
      responsesSseFrame({
        type: "response.created",
        response: { id: "resp_3", model: "m", created_at: 100 },
      }),
      responsesSseFrame({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", call_id: "t1", name: "search" },
      }),
      responsesSseFrame({
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: '{"q":"x"}',
      }),
      responsesSseFrame({
        type: "response.completed",
        response: {
          id: "resp_3",
          status: "completed",
          output: [{ type: "function_call", call_id: "t1", name: "search" }],
        },
      }),
    ],
  );
  const chunks = parseChatSse(raw);
  const toolChunks = chunks.filter(
    (c) =>
      (c.choices as Array<{ delta?: { tool_calls?: unknown[] } }>)[0]?.delta
        ?.tool_calls,
  );
  assert.ok(
    toolChunks.length >= 2,
    "expected an opening chunk + an arguments-delta chunk",
  );
  const opening = (
    toolChunks[0].choices as Array<{
      delta: {
        tool_calls: Array<{ id?: string; function?: { name?: string } }>;
      };
    }>
  )[0].delta.tool_calls[0];
  assert.equal(opening.id, "t1");
  assert.equal(opening.function?.name, "search");
  const last = chunks[chunks.length - 1];
  assert.equal(
    (last.choices as Array<{ finish_reason?: string }>)[0].finish_reason,
    "tool_calls",
  );
});

test("streaming (inverse): _flush() emits a terminal chunk + [DONE] even if response.completed never arrived", async () => {
  const raw = await runTransform(
    new StreamingResponsesToChatBridgeTransform(),
    [
      responsesSseFrame({
        type: "response.created",
        response: { id: "resp_4", model: "m", created_at: 100 },
      }),
      responsesSseFrame({ type: "response.output_text.delta", delta: "hi" }),
      // stream ends abruptly, no response.completed
    ],
  );
  assert.ok(raw.includes("data: [DONE]"));
});

// --- streaming (forward): Chat SSE -> Responses SSE -------------------------
// StreamingResponsesBridgeTransform — had ZERO test coverage before this.

test("streaming (forward): content deltas -> response.output_text.delta events, terminated by response.completed", async () => {
  const raw = await runTransform(new StreamingResponsesBridgeTransform(), [
    chatSseFrame({
      id: "cc1",
      created: 100,
      model: "m",
      choices: [{ index: 0, delta: { role: "assistant" } }],
    }),
    chatSseFrame({
      id: "cc1",
      choices: [{ index: 0, delta: { content: "Hel" } }],
    }),
    chatSseFrame({
      id: "cc1",
      choices: [{ index: 0, delta: { content: "lo" } }],
    }),
    chatSseFrame({
      id: "cc1",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }),
    "data: [DONE]\n\n",
  ]);
  const events = parseResponsesSse(raw);
  assert.ok(events.some((e) => e.type === "response.created"));
  const textDeltas = events
    .filter((e) => e.type === "response.output_text.delta")
    .map((e) => e.delta);
  assert.deepEqual(textDeltas, ["Hel", "lo"]);
  const completed = events.find((e) => e.type === "response.completed");
  assert.ok(completed, "expected a response.completed event");
  const response = (completed as { response: ResponsesResponse }).response;
  assert.equal(response.status, "completed");
  assert.equal(response.usage?.input_tokens, 3);
  assert.equal(response.usage?.output_tokens, 2);
});

test("streaming (forward): reasoning deltas -> response.reasoning_text.delta events, closed before text starts", async () => {
  const raw = await runTransform(new StreamingResponsesBridgeTransform(), [
    chatSseFrame({
      id: "cc2",
      created: 100,
      model: "m",
      choices: [{ index: 0, delta: { reasoning_content: "thinking..." } }],
    }),
    chatSseFrame({
      id: "cc2",
      choices: [{ index: 0, delta: { content: "answer" } }],
    }),
    chatSseFrame({
      id: "cc2",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }),
    "data: [DONE]\n\n",
  ]);
  const events = parseResponsesSse(raw);
  const reasoningDeltas = events
    .filter((e) => e.type === "response.reasoning_text.delta")
    .map((e) => e.delta);
  assert.deepEqual(reasoningDeltas, ["thinking..."]);
  // The reasoning content_part must be closed (content_part.done) before the
  // text output starts — reasoning always precedes the answer in a turn.
  const reasoningDoneIdx = events.findIndex(
    (e) =>
      e.type === "response.content_part.done" &&
      (e.part as { type?: string })?.type === "reasoning_text",
  );
  const textDeltaIdx = events.findIndex(
    (e) => e.type === "response.output_text.delta",
  );
  assert.ok(reasoningDoneIdx !== -1 && textDeltaIdx !== -1);
  assert.ok(reasoningDoneIdx < textDeltaIdx);
});

test("streaming (forward): tool_calls deltas -> function_call output item + argument deltas", async () => {
  const raw = await runTransform(new StreamingResponsesBridgeTransform(), [
    chatSseFrame({
      id: "cc3",
      created: 100,
      model: "m",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "search", arguments: "" },
              },
            ],
          },
        },
      ],
    }),
    chatSseFrame({
      id: "cc3",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"q":"x"}' } }],
          },
        },
      ],
    }),
    chatSseFrame({
      id: "cc3",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    }),
    "data: [DONE]\n\n",
  ]);
  const events = parseResponsesSse(raw);
  const added = events.find(
    (e) =>
      e.type === "response.output_item.added" &&
      (e.item as { type?: string })?.type === "function_call",
  );
  assert.ok(added, "expected a function_call output_item.added event");
  const item = added!.item as { call_id?: string; name?: string };
  assert.equal(item.call_id, "call_1");
  assert.equal(item.name, "search");

  const argDeltas = events
    .filter((e) => e.type === "response.function_call_arguments.delta")
    .map((e) => e.delta)
    .join("");
  assert.equal(argDeltas, '{"q":"x"}');

  const completed = events.find((e) => e.type === "response.completed");
  const response = (completed as { response: ResponsesResponse }).response;
  assert.equal(response.status, "completed");
});

test("streaming (forward): _flush() emits response.completed even if the upstream stream ends without one", async () => {
  const raw = await runTransform(new StreamingResponsesBridgeTransform(), [
    chatSseFrame({
      id: "cc4",
      created: 100,
      model: "m",
      choices: [{ index: 0, delta: { content: "hi" } }],
    }),
    // stream ends abruptly, no finish_reason/[DONE]
  ]);
  const events = parseResponsesSse(raw);
  assert.ok(events.some((e) => e.type === "response.completed"));
});

test("streaming round-trip: chat SSE -> responses SSE -> chat SSE preserves text + tool calls", async () => {
  const chatToResponses = await runTransform(
    new StreamingResponsesBridgeTransform(),
    [
      chatSseFrame({
        id: "cc5",
        created: 100,
        model: "m",
        choices: [{ index: 0, delta: { content: "hello" } }],
      }),
      chatSseFrame({
        id: "cc5",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
      "data: [DONE]\n\n",
    ],
  );
  // Feed the RESPONSES-shaped output of the forward bridge into the inverse
  // bridge and confirm the text survives the full round trip.
  const backToChat = await runTransform(
    new StreamingResponsesToChatBridgeTransform(),
    chatToResponses
      .split("\n\n")
      .filter((f) => f.trim())
      .map((f) => f + "\n\n"),
  );
  const chunks = parseChatSse(backToChat);
  const content = chunks
    .map(
      (c) =>
        (c.choices as Array<{ delta?: { content?: string } }>)[0]?.delta
          ?.content,
    )
    .filter((c): c is string => !!c)
    .join("");
  assert.equal(content, "hello");
});
