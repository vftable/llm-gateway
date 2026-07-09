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

// SSE keepalive heartbeat for the web-tool loop.
//
// Unlike the normal streaming path (which pipes upstream bytes through
// SsePingKeepAlive), the web-tool loop runs every upstream turn + web search
// BUFFERED before it emits anything — so the client's SSE connection would sit
// idle for the whole loop and time out at the proxy's ~90s ceiling. This opens
// the SSE response immediately and writes `: ping\n\n` comment lines on an
// interval, keeping the connection warm until the final message is ready.
//
// Clients ignore SSE comment lines (leading `:`), so the pings are invisible to
// the parsed event stream; only the bytes matter. Call stop() before emitting
// the real events so no ping interleaves the message body.
export interface SseHeartbeat {
  stop(): void;
}

export function startSseHeartbeat(
  res: Response,
  intervalMs: number,
): SseHeartbeat {
  // Disabled (interval <= 0) or the response is already committed to a
  // non-streaming body — nothing to keep alive.
  if (intervalMs <= 0 || res.headersSent) {
    return { stop() {} };
  }
  openSse(res);
  // Flush headers so the client sees the 200 + content-type right away, rather
  // than waiting for the first byte of body — some proxies start their idle
  // timer only after headers, others only after first data, so we do both.
  res.write(": ok\n\n");

  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || res.writableEnded) return;
    try {
      res.write(": ping\n\n");
    } catch {
      /* client gone — the loop's own error handling will settle */
    }
  }, intervalMs);
  // Don't let the heartbeat keep the process alive on its own.
  if (timer && typeof timer === "object" && "unref" in timer) timer.unref();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
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

// Emit an error onto an already-open SSE stream and close it.
//
// Once the heartbeat has flushed headers we can no longer answer a mid-loop
// failure with an HTTP 502 (headers are committed to a 200 stream). Instead we
// send Anthropic's SSE `error` event so a streaming client sees a clean failure
// rather than a truncated/hung stream. Safe to call even if the stream is only
// partially set up.
export function emitSseError(res: Response, message: string): void {
  if (res.writableEnded) return;
  openSse(res);
  try {
    writeEvent(res, "error", {
      type: "error",
      error: { type: "api_error", message },
    });
    res.end();
  } catch {
    /* client already gone */
  }
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
