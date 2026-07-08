// Synthesise a client-facing SSE stream from a FINAL (already-complete) message.
//
// The web-tool loop runs upstream turns non-streaming (so it can inspect
// tool_use). But a streaming client still expects an SSE response, so once the
// loop has the final assistant message we replay it as a well-formed event
// sequence. It isn't token-by-token (the answer is already known), but it is a
// protocol-correct stream the client parses normally.

import type { Response } from "express";

function writeEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function openSse(res: Response): void {
  if (!res.headersSent)
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
}

// Anthropic Messages SSE from a final Messages body:
//   message_start -> (per block: content_block_start/delta/stop)
//   -> message_delta(stop_reason, usage) -> message_stop
export function emitMessagesSse(
  res: Response,
  message: Record<string, unknown>,
): void {
  openSse(res);
  const content = Array.isArray(message.content) ? message.content : [];
  const usage = (message.usage as Record<string, unknown>) ?? {
    input_tokens: 0,
    output_tokens: 0,
  };

  writeEvent(res, "message_start", {
    type: "message_start",
    message: {
      id: message.id ?? "msg_gateway",
      type: "message",
      role: "assistant",
      model: message.model ?? "",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: 0 },
    },
  });

  content.forEach((blockRaw, index) => {
    const block = (blockRaw ?? {}) as Record<string, unknown>;
    const type = block.type;
    if (type === "text") {
      writeEvent(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      writeEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: String(block.text ?? "") },
      });
      writeEvent(res, "content_block_stop", {
        type: "content_block_stop",
        index,
      });
    } else if (type === "thinking") {
      writeEvent(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "" },
      });
      writeEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "thinking_delta",
          thinking: String(block.thinking ?? ""),
        },
      });
      writeEvent(res, "content_block_stop", {
        type: "content_block_stop",
        index,
      });
    } else if (type === "tool_use" || type === "server_tool_use") {
      // Client tool call (tool_use) or gateway-run hosted tool (server_tool_use)
      // — both stream a start block then the input as an input_json_delta.
      writeEvent(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type,
          id: block.id ?? "toolu_gateway",
          name: block.name ?? "",
          input: {},
        },
      });
      writeEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input ?? {}),
        },
      });
      writeEvent(res, "content_block_stop", {
        type: "content_block_stop",
        index,
      });
    } else if (type === "web_search_tool_result") {
      // Hosted-tool result: a single start block carrying the full result
      // content (result items or an error object), then stop. There is no delta
      // for these — the content is delivered whole in the start event.
      writeEvent(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: block.tool_use_id ?? "",
          content: block.content ?? [],
        },
      });
      writeEvent(res, "content_block_stop", {
        type: "content_block_stop",
        index,
      });
    }
  });

  writeEvent(res, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: message.stop_reason ?? "end_turn",
      stop_sequence: null,
    },
    usage: {
      output_tokens: usage.output_tokens ?? 0,
      // Surface hosted-tool search count in the terminal usage delta, matching
      // Anthropic's real streaming shape.
      ...(usage.server_tool_use
        ? { server_tool_use: usage.server_tool_use }
        : {}),
    },
  });
  writeEvent(res, "message_stop", { type: "message_stop" });
  res.end();
}

// OpenAI Chat Completions SSE from a final chat.completion body:
//   role delta -> content delta -> tool_call deltas -> finish -> [DONE]
export function emitChatSse(
  res: Response,
  chat: Record<string, unknown>,
): void {
  openSse(res);
  const choice = (Array.isArray(chat.choices) ? chat.choices[0] : {}) as Record<
    string,
    unknown
  >;
  const message = (choice.message ?? {}) as Record<string, unknown>;
  const id = chat.id ?? "chatcmpl-gateway";
  const model = chat.model ?? "";
  const created = chat.created ?? Math.floor(Date.now() / 1000);

  const base = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
  };
  // OpenAI chunks are bare `data:` lines (no SSE `event:` field).
  const chunk = (delta: unknown, finish: string | null = null) => {
    res.write(
      `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    );
  };

  chunk({ role: "assistant" });
  if (typeof message.content === "string" && message.content)
    chunk({ content: message.content });
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((tcRaw, i) => {
      const tc = (tcRaw ?? {}) as Record<string, unknown>;
      const fn = (tc.function ?? {}) as Record<string, unknown>;
      chunk({
        tool_calls: [
          {
            index: i,
            id: tc.id,
            type: "function",
            function: { name: fn.name, arguments: fn.arguments ?? "" },
          },
        ],
      });
    });
  }
  chunk({}, String(choice.finish_reason ?? "stop"));
  // OpenAI streams terminate with a literal [DONE] on a data: line.
  res.write("data: [DONE]\n\n");
  res.end();
}
