// Web-tool agent loop.
//
// When a Messages request asks for the hosted web_search / web_fetch tools and
// the gateway is configured to back them with Firecrawl, this loop takes over:
//
//   1. Rewrite the hosted tool defs into ordinary function tools.
//   2. Run a non-streaming upstream turn (engine.runMessagesTurn).
//   3. If the model emitted web tool_use blocks, execute them via Firecrawl,
//      append an assistant turn + a user turn of tool_result, and loop.
//   4. When the model stops calling web tools (or we hit the round cap), emit
//      the final assistant message to the client — as SSE if the client asked
//      to stream, otherwise as a single JSON body — in the CLIENT's wire
//      format (Messages or, if the client used /chat or /responses, bridged).
//
// The loop itself never streams from the upstream (each turn is buffered so we
// can inspect tool_use). Streaming to the CLIENT is synthesised at the end from
// the final message, so the client still gets an SSE response when it asked for
// one — the gateway just can't stream tokens *while a tool call is pending*.

import { randomBytes } from "crypto";
import type { Request, Response } from "express";
import type { Logger } from "../logger";
import type { ForwardingEngine, ForwardContext } from "../gateway/engine";
import type { SearchProvider } from "./backends";
import {
  rewriteRequest,
  executeWebTool,
  isWebToolName,
  isWebToolsOnly,
  getLastUserQuery,
  WEB_SEARCH,
  type WebToolsPresent,
} from "./tools";
import { messagesResponseToChat } from "../formats/anthropic/bridge";
import {
  emitMessagesSse,
  emitChatSse,
  emitSseError,
  startSseHeartbeat,
  type SseHeartbeat,
} from "./sse";

const MAX_ROUNDS = 6; // hard cap on tool round-trips per request
// Max total web searches/fetches before we strip the tools and force the model
// to answer with what it has. Prevents runaway re-searching (slow + burns
// Firecrawl credits) when a model keeps rephrasing the same query.
const MAX_SEARCHES = 3;

export interface LoopDeps {
  engine: ForwardingEngine;
  logger: Logger;
  provider: SearchProvider;
}

// Client wire format, derived from the request path.
type ClientFmt = "messages" | "chat" | "responses";

function clientFmt(path: string): ClientFmt {
  const p = path.split("?")[0];
  if (p.endsWith("/chat/completions")) return "chat";
  if (p.endsWith("/responses")) return "responses";
  return "messages";
}

interface Usage {
  input?: number;
  output?: number;
  cached?: number;
}

// Run the loop. Returns settlement info so the caller (engine hook) can update
// usage + write the request log exactly once, consistent with normal requests.
export async function runWebToolLoop(
  req: Request,
  res: Response,
  ctx: ForwardContext,
  present: WebToolsPresent,
  deps: LoopDeps,
): Promise<{ status: number; usage: Usage; error: string | null }> {
  const { engine, logger, provider } = deps;
  const fmt = clientFmt(ctx.clientPath);
  const wantStream = ctx.isStream;

  // Streaming clients get an SSE keepalive for the whole loop: every upstream
  // turn + web search runs BUFFERED before we can emit the final message, so
  // without this the connection sits idle and a proxy drops it at ~90s. The
  // heartbeat opens the SSE response now and pings until we're ready to emit.
  const heartbeat: SseHeartbeat | null = wantStream
    ? startSseHeartbeat(res, engine.pingInterval)
    : null;

  // Short-circuit: Claude Code sends web search as a standalone /v1/messages
  // sub-request with ONLY web tools + a simple prompt, and just wants the
  // web_search_tool_result blocks back to render — it does its own synthesis in
  // the main conversation. Running this through the upstream model is
  // unnecessary and (with an OpenAI-format upstream) unreliable. So we run the
  // search directly and return a synthetic Anthropic response — exactly how
  // LiteLLM's try_short_circuit_search works. This is the path that "just
  // works" for Claude Code.
  if (present.search && isWebToolsOnly(ctx.requestBody)) {
    const query = getLastUserQuery(ctx.requestBody);
    if (query) {
      const status = await runShortCircuitSearch(
        res,
        ctx,
        query,
        fmt,
        wantStream,
        deps,
        heartbeat,
      );
      return status;
    }
  }

  // Working conversation in Messages shape. If the client spoke chat/responses,
  // ctx.requestBody has already been handed to us in Messages shape by the hook
  // (it converts before calling us), so we can treat it uniformly.
  const base = rewriteRequest(ctx.requestBody, present);
  const messages: unknown[] = Array.isArray(base.messages)
    ? [...(base.messages as unknown[])]
    : [];

  const total: Usage = {};
  const addUsage = (u: Usage) => {
    if (u.input) total.input = (total.input ?? 0) + u.input;
    if (u.output) total.output = (total.output ?? 0) + u.output;
    if (u.cached) total.cached = (total.cached ?? 0) + u.cached;
  };

  // Route a failure to the client correctly given the stream may already be
  // open: emit an SSE error event (headers are committed) rather than relying on
  // the caller's 502 path, which can no longer set a status.
  const fail = (status: number, error: string) => {
    heartbeat?.stop();
    if (wantStream) emitSseError(res, error);
    return { status, usage: total, error };
  };

  let finalMessage: Record<string, unknown> | null = null;
  let lastMessage: Record<string, unknown> | null = null;
  let lastStatus = 200;
  let searchCount = 0;
  let searchRequests = 0; // billed web_search_requests for usage reporting
  // Anthropic-native web-tool blocks accumulated across rounds, prepended to
  // the final client-facing message so the client sees the hosted-tool trace:
  //   server_tool_use -> web_search_tool_result -> ... -> (assistant text)
  const webBlocks: unknown[] = [];

  // Base body WITHOUT the web tools — used once the search budget is spent so
  // the model can no longer call them and must answer.
  const baseNoTools = { ...base };
  delete baseNoTools.tools;
  delete baseNoTools.tool_choice;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const budgetSpent = searchCount >= MAX_SEARCHES;
    const turnBody = budgetSpent
      ? { ...baseNoTools, messages }
      : { ...base, messages };
    const turn = await engine.runMessagesTurn(req, ctx, turnBody);
    if (!turn.ok) {
      return fail(
        turn.status,
        `web-tool loop upstream failure: ${turn.reason}`,
      );
    }
    addUsage(turn.usage);
    const msg = turn.body;
    lastStatus = 200;
    lastMessage = msg;

    const content = Array.isArray(msg.content) ? msg.content : [];
    const toolUses = content.filter(
      (b) =>
        b &&
        typeof b === "object" &&
        (b as Record<string, unknown>).type === "tool_use" &&
        isWebToolName((b as Record<string, unknown>).name),
    ) as Array<Record<string, unknown>>;

    // No web tool calls -> this is the final answer. Its assistant text/blocks
    // are appended after the accumulated web-tool blocks below.
    if (toolUses.length === 0) {
      finalMessage = msg;
      break;
    }

    logger.info("web_tool_round", {
      round: round + 1,
      calls: toolUses.map((t) => t.name).join(","),
    });

    // Append the assistant turn (with its tool_use blocks) to the UPSTREAM
    // conversation verbatim, so the model can reason over the results next turn.
    messages.push({ role: "assistant", content: msg.content });

    // Interleave any assistant "decision to search" text before this round's
    // tool blocks, matching Anthropic's real ordering:
    //   text (decision) -> server_tool_use -> web_search_tool_result -> ...
    for (const b of content) {
      if (
        b &&
        typeof b === "object" &&
        (b as Record<string, unknown>).type === "text" &&
        typeof (b as Record<string, unknown>).text === "string" &&
        (b as Record<string, unknown>).text
      ) {
        webBlocks.push({
          type: "text",
          text: (b as Record<string, unknown>).text,
        });
      }
    }

    // Execute each web tool call: feed text back to the model, and record the
    // Anthropic-native server_tool_use + web_search_tool_result blocks for the
    // client.
    const toolResults: unknown[] = [];
    for (const tu of toolUses) {
      searchCount++;
      searchRequests++;
      const input = (tu.input as Record<string, unknown>) ?? {};
      const outcome = await executeWebTool(provider, String(tu.name), input);

      // Anthropic uses the "srvtoolu_" prefix for server (hosted) tool ids; the
      // upstream model emits "toolu_"/"call_", so we mint a matching srv id and
      // link the result block to it. The upstream conversation keeps the
      // model's original id (tu.id) so the text tool_result still matches.
      const srvId = toServerToolId(String(tu.id ?? ""));

      // Client-facing: the model's call as a server_tool_use block...
      webBlocks.push({
        type: "server_tool_use",
        id: srvId,
        name: tu.name,
        input,
      });
      // ...followed by the result block (error or web_search_result items).
      if (outcome.error) {
        webBlocks.push({
          type: "web_search_tool_result",
          tool_use_id: srvId,
          content: {
            type: "web_search_tool_result_error",
            error_code: "unavailable",
          },
        });
      } else {
        webBlocks.push({
          type: "web_search_tool_result",
          tool_use_id: srvId,
          content: outcome.results ?? [],
        });
      }

      // Upstream-facing: plain-text tool result so the model reasons over it.
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: [{ type: "text", text: outcome.text }],
      });
    }

    // Any NON-web tool_use in the same turn can't be satisfied by us — hand back
    // what we have so the client can take over.
    const hasForeignTool = content.some(
      (b) =>
        b &&
        typeof b === "object" &&
        (b as Record<string, unknown>).type === "tool_use" &&
        !isWebToolName((b as Record<string, unknown>).name),
    );
    if (hasForeignTool) {
      finalMessage = msg;
      break;
    }
    messages.push({ role: "user", content: toolResults });
  }

  if (!finalMessage) {
    // Round cap hit without a clean finish. Fall back to the last assistant
    // message (its text, minus any dangling tool_use blocks we can't service)
    // so the client still gets the searches + whatever the model last said.
    if (lastMessage) {
      const lc = Array.isArray(lastMessage.content) ? lastMessage.content : [];
      finalMessage = {
        ...lastMessage,
        content: lc.filter(
          (b) =>
            !(
              b &&
              typeof b === "object" &&
              (b as Record<string, unknown>).type === "tool_use"
            ),
        ),
        stop_reason: "end_turn",
      };
      logger.warn("web_tool_loop_capped", { rounds: MAX_ROUNDS, searchCount });
    } else {
      return fail(200, `web-tool loop exceeded ${MAX_ROUNDS} rounds`);
    }
  }

  // Assemble the client-facing message: the interleaved web-tool trace
  // (decision text -> server_tool_use -> web_search_tool_result -> ...) followed
  // by the model's final answer content. Non-web tool_use blocks from the final
  // turn (client tools) are preserved so the client can execute them.
  const finalContent = Array.isArray(finalMessage.content)
    ? finalMessage.content
    : [];
  // Inject Anthropic's usage.server_tool_use.web_search_requests so clients that
  // track search billing/counts see the correct number.
  const baseUsage =
    (finalMessage.usage as Record<string, unknown> | undefined) ?? {};
  const clientMessage: Record<string, unknown> = {
    ...finalMessage,
    // Normalise the id to Anthropic's "msg_" form (the upstream may return a
    // "chatcmpl-…" id that leaks through the OpenAI->Messages bridge).
    id: toMessageId(finalMessage.id),
    content: [...webBlocks, ...finalContent],
    usage: {
      ...baseUsage,
      server_tool_use: { web_search_requests: searchRequests },
    },
  };

  // Stop the keepalive before writing the real events so no `: ping` comment
  // interleaves the message body.
  heartbeat?.stop();

  // Emit to the client in its wire format.
  try {
    if (fmt === "chat") {
      // Chat Completions has no server_tool_use concept; emit just the final
      // answer (the web trace isn't expressible in that schema).
      const chat = messagesResponseToChat(finalMessage);
      if (wantStream) emitChatSse(res, chat);
      else sendJson(res, lastStatus, chat);
    } else {
      if (wantStream) emitMessagesSse(res, clientMessage);
      else sendJson(res, lastStatus, clientMessage);
    }
  } catch (err) {
    return {
      status: 500,
      usage: total,
      error: `web-tool loop emit failed: ${(err as Error).message}`,
    };
  }

  return { status: lastStatus, usage: total, error: null };
}

// Short-circuit path: run the search directly (no model call) and return a
// synthetic Anthropic response — server_tool_use + web_search_tool_result +
// text — for a standalone web-search-only request. Mirrors LiteLLM's
// try_short_circuit_search. This is what Claude Code hits.
async function runShortCircuitSearch(
  res: Response,
  ctx: ForwardContext,
  query: string,
  fmt: ClientFmt,
  wantStream: boolean,
  deps: LoopDeps,
  heartbeat: SseHeartbeat | null,
): Promise<{ status: number; usage: Usage; error: string | null }> {
  const { logger, provider } = deps;
  logger.info("web_tool_short_circuit", {
    query: query.slice(0, 80),
    stream: wantStream,
  });

  const outcome = await executeWebTool(provider, WEB_SEARCH, { query });
  const toolUseId = `srvtoolu_${randHex(24)}`;

  const content: unknown[] = [
    {
      type: "server_tool_use",
      id: toolUseId,
      name: WEB_SEARCH,
      input: { query },
    },
    outcome.error
      ? {
          type: "web_search_tool_result",
          tool_use_id: toolUseId,
          content: {
            type: "web_search_tool_result_error",
            error_code: "unavailable",
          },
        }
      : {
          type: "web_search_tool_result",
          tool_use_id: toolUseId,
          content: outcome.results ?? [],
        },
    // Keep the text block so non-native callers see the same payload shape they
    // always have (LiteLLM does this too).
    { type: "text", text: outcome.text },
  ];

  const message: Record<string, unknown> = {
    id: `msg_${randHex(24)}`,
    type: "message",
    role: "assistant",
    model: ctx.alias,
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      server_tool_use: { web_search_requests: 1 },
    },
  };

  // Stop the keepalive before writing the real events so no `: ping` comment
  // interleaves the message body.
  heartbeat?.stop();

  try {
    if (fmt === "chat") {
      const chat = messagesResponseToChat(message);
      if (wantStream) emitChatSse(res, chat);
      else sendJson(res, 200, chat);
    } else {
      if (wantStream) emitMessagesSse(res, message);
      else sendJson(res, 200, message);
    }
  } catch (err) {
    return {
      status: 500,
      usage: {},
      error: `short-circuit emit failed: ${(err as Error).message}`,
    };
  }
  // A Firecrawl failure is delivered to the client as a 200 with an in-body
  // web_search_tool_result_error block (per Anthropic's spec), NOT a request
  // error — so the response is a success. Surface the search failure only in
  // the log note, without flipping the request to an error.
  if (outcome.error)
    logger.warn("web_tool_search_failed", { error: outcome.error });
  return { status: 200, usage: {}, error: null };
}

// Short random hex id suffix (Anthropic-style opaque ids).
function randHex(len: number): string {
  const bytes = randomBytes(Math.ceil(len / 2));
  return bytes.toString("hex").slice(0, len);
}

// Normalise an upstream tool id ("toolu_…", "call_…") into Anthropic's server
// tool id form ("srvtoolu_…"), stripping any existing known prefix so the
// suffix is preserved and the pairing with its result block stays unique.
function toServerToolId(id: string): string {
  const suffix = id.replace(/^(srvtoolu_|toolu_|call_)/, "");
  return `srvtoolu_${suffix || randHex(24)}`;
}

// Normalise a message id to Anthropic's "msg_" form. Strips a leading
// "chatcmpl-" (OpenAI) and any existing "msg_" so we don't double-prefix.
function toMessageId(id: unknown): string {
  const s = typeof id === "string" ? id : "";
  const suffix = s.replace(/^chatcmpl-/, "").replace(/^msg_/, "");
  return `msg_${suffix || randHex(24)}`;
}

function sendJson(res: Response, status: number, body: unknown): void {
  if (res.headersSent) return;
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(buf.length),
  });
  res.end(buf);
}
