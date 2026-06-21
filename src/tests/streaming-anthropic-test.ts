// End-to-end test for the AnthropicThinkingTransform on /v1/messages streams.
// Verifies that:
//   1. <thinking>...</thinking> inside a text content block is split out into
//      a proper Anthropic `thinking` content block, with the remaining text
//      continuing in a fresh text block.
//   2. Tool calls still work: when a thinking split inflates the block count,
//      subsequent tool_use blocks get their indices remapped so the client
//      sees contiguous indices.
//   3. Tag boundaries split across upstream chunks resolve correctly.
//   4. Text-only streams (no <thinking>) pass through cleanly.
//   5. Multiple thinking blocks in one response each become their own block.
//   6. Lifecycle events (message_start/delta/stop, ping) survive.
//   7. Malformed SSE events fall through to verbatim passthrough.
//   8. Timing is preserved (we don't buffer the whole stream before emitting).

import http from "http";
import express from "express";
import { loadConfig } from "../config";
import { Logger } from "../logger";
import { ModelRegistry } from "../models";
import { ThinkingConverter } from "../thinking";
import { ResponsesBridge } from "../responses-bridge";
import { GatewayProxy } from "../proxy";
import { AnthropicThinkingTransform } from "../streaming-anthropic";

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, cond: unknown, detail?: string): void {
  results.push({ name, ok: !!cond });
  console.log(
    (cond ? "PASS" : "FAIL") + " - " + name + (cond ? "" : " :: " + detail),
  );
}

// --- helpers ---------------------------------------------------------------

type ParsedSse = { event: string; data: Record<string, unknown> | null };

function parseSse(raw: string): ParsedSse {
  const lines = raw.split("\n");
  let event = "";
  let dataStr = "";
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      const p = line.slice(5);
      dataStr += p.startsWith(" ") ? p.slice(1) : p;
    }
  }
  try {
    return { event, data: JSON.parse(dataStr) };
  } catch {
    return { event, data: null };
  }
}

function ev(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Feed raw SSE strings through a fresh transform; resolve with the emitted
// events as parsed objects.
function feedTransform(events: string[]): Promise<ParsedSse[]> {
  return new Promise((resolve, reject) => {
    const t = new AnthropicThinkingTransform();
    const chunks: Buffer[] = [];
    t.on("data", (buf: Buffer) => chunks.push(buf));
    t.on("error", reject);
    t.on("end", () => {
      const joined = Buffer.concat(chunks).toString("utf8");
      const parsed = joined
        .split("\n\n")
        .filter((s) => s.length > 0)
        .map((s) => parseSse(s + "\n\n"));
      resolve(parsed);
    });
    for (const e of events) t.write(Buffer.from(e, "utf8"));
    t.end();
  });
}

// ===========================================================================
// All tests run inside one async main to keep top-level await out of CJS.
// ===========================================================================

async function main(): Promise<void> {
  // --- Unit test 1: basic thinking split ----------------------------------
  {
    const parsed = await feedTransform([
      ev("message_start", {
        type: "message_start",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
      ev("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: "<thinking>let me think</thinking>final answer",
        },
      }),
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
      ev("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 5 },
      }),
      ev("message_stop", { type: "message_stop" }),
    ]);

    const starts = parsed.filter((p) => p.event === "content_block_start");
    const stops = parsed.filter((p) => p.event === "content_block_stop");
    const deltas = parsed.filter((p) => p.event === "content_block_delta");
    const thinkingStarts = starts.filter(
      (p) => (p.data?.content_block as { type?: string })?.type === "thinking",
    );
    const textStarts = starts.filter(
      (p) => (p.data?.content_block as { type?: string })?.type === "text",
    );
    const thinkingDeltas = deltas.filter(
      (p) => (p.data?.delta as { type?: string })?.type === "thinking_delta",
    );
    const textDeltas = deltas.filter(
      (p) => (p.data?.delta as { type?: string })?.type === "text_delta",
    );

    check(
      "unit: thinking block opened",
      thinkingStarts.length === 1,
      JSON.stringify(starts),
    );
    check(
      "unit: text block opened after thinking",
      textStarts.length === 1,
      JSON.stringify(starts),
    );
    check(
      "unit: thinking_delta carries reasoning text",
      thinkingDeltas.length === 1 &&
        (thinkingDeltas[0].data!.delta as { thinking: string }).thinking ===
          "let me think",
      JSON.stringify(thinkingDeltas),
    );
    check(
      "unit: text_delta carries answer text",
      textDeltas.length === 1 &&
        (textDeltas[0].data!.delta as { text: string }).text === "final answer",
      JSON.stringify(textDeltas),
    );
    check(
      "unit: contiguous block indices (0 thinking, 1 text)",
      thinkingStarts[0].data!.index === 0 && textStarts[0].data!.index === 1,
      JSON.stringify(starts),
    );
    check(
      "unit: both blocks closed before message_delta",
      stops.length === 2 &&
        stops.every(
          (s) =>
            parsed.indexOf(s) <
            parsed.findIndex((p) => p.event === "message_delta"),
        ),
      JSON.stringify(stops),
    );
    check(
      "unit: message lifecycle preserved",
      parsed.some((p) => p.event === "message_start") &&
        parsed.some((p) => p.event === "message_delta") &&
        parsed.some((p) => p.event === "message_stop"),
      JSON.stringify(parsed.map((p) => p.event)),
    );
  }

  // --- Unit test 2: thinking tag split across upstream chunks -------------
  {
    const parsed = await feedTransform([
      ev("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "<thi" },
      }),
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "nking>reason</thin" },
      }),
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "king>body" },
      }),
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ]);
    const thinkingText = parsed
      .filter(
        (p) => (p.data?.delta as { type?: string })?.type === "thinking_delta",
      )
      .map((p) => (p.data!.delta as { thinking: string }).thinking)
      .join("");
    const textText = parsed
      .filter(
        (p) => (p.data?.delta as { type?: string })?.type === "text_delta",
      )
      .map((p) => (p.data!.delta as { text: string }).text)
      .join("");
    check(
      "unit-split: reasoning reassembled across chunks",
      thinkingText === "reason",
      JSON.stringify(thinkingText),
    );
    check(
      "unit-split: content reassembled across chunks",
      textText === "body",
      JSON.stringify(textText),
    );
  }

  // --- Unit test 3: tool_use still works after a thinking split -----------
  {
    const parsed = await feedTransform([
      ev("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: "<thinking>plan</thinking>calling tool",
        },
      }),
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
      ev("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "toolu_1",
          name: "get_weather",
          input: {},
        },
      }),
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"loc":"sf"}' },
      }),
      ev("content_block_stop", { type: "content_block_stop", index: 1 }),
      ev("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 10 },
      }),
      ev("message_stop", { type: "message_stop" }),
    ]);

    const toolStart = parsed.find(
      (p) =>
        p.event === "content_block_start" &&
        (p.data?.content_block as { type?: string })?.type === "tool_use",
    );
    const toolDelta = parsed.find(
      (p) => (p.data?.delta as { type?: string })?.type === "input_json_delta",
    );
    const toolStops = parsed.filter((p) => p.event === "content_block_stop");

    check(
      "unit-tool: tool_use remapped to index 2 (after thinking 0 + text 1)",
      toolStart?.data?.index === 2,
      JSON.stringify(toolStart?.data),
    );
    check(
      "unit-tool: tool_use id/name preserved",
      (toolStart?.data?.content_block as { id?: string; name?: string })?.id ===
        "toolu_1" &&
        (toolStart?.data?.content_block as { id?: string; name?: string })
          ?.name === "get_weather",
      JSON.stringify(toolStart?.data),
    );
    check(
      "unit-tool: input_json_delta forwarded on remapped index",
      toolDelta?.data?.index === 2 &&
        (toolDelta!.data!.delta as { partial_json: string }).partial_json ===
          '{"loc":"sf"}',
      JSON.stringify(toolDelta?.data),
    );
    check(
      "unit-tool: tool_use stop emitted with remapped index",
      toolStops.some((p) => p.data?.index === 2),
      JSON.stringify(toolStops),
    );
    check(
      "unit-tool: stop_reason preserved as tool_use",
      parsed.some(
        (p) =>
          p.event === "message_delta" &&
          (p.data?.delta as { stop_reason?: string })?.stop_reason ===
            "tool_use",
      ),
      JSON.stringify(parsed.filter((p) => p.event === "message_delta")),
    );
  }

  // --- Unit test 4: no thinking — passthrough, no spurious blocks ---------
  {
    const parsed = await feedTransform([
      ev("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "just an answer" },
      }),
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ]);
    const thinkingStarts = parsed.filter(
      (p) => (p.data?.content_block as { type?: string })?.type === "thinking",
    );
    const textContent = parsed
      .filter(
        (p) => (p.data?.delta as { type?: string })?.type === "text_delta",
      )
      .map((p) => (p.data!.delta as { text: string }).text)
      .join("");
    check(
      "unit-nothink: no thinking block created",
      thinkingStarts.length === 0,
      JSON.stringify(thinkingStarts),
    );
    check(
      "unit-nothink: text content preserved",
      textContent === "just an answer",
      JSON.stringify(textContent),
    );
  }

  // --- Unit test 5: malformed SSE event passes through verbatim -----------
  {
    const parsed = await feedTransform([
      "event: content_block_delta\ndata: {not valid json\n\n",
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      }),
    ]);
    // Malformed event should be forwarded as-is (no parseable data); good
    // event should still be processed normally.
    check(
      "unit-error: malformed event forwarded verbatim",
      parsed.some((p) => p.event === "content_block_delta" && p.data === null),
      JSON.stringify(parsed),
    );
    check(
      "unit-error: valid event still processed after error",
      parsed.some(
        (p) =>
          (p.data?.delta as { type?: string; text?: string })?.type ===
            "text_delta" && (p.data!.delta as { text: string }).text === "ok",
      ),
      JSON.stringify(parsed),
    );
  }

  // --- Unit test 6: multiple thinking blocks each get their own block -----
  {
    const parsed = await feedTransform([
      ev("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: "<thinking>first</thinking>middle<thinking>second</thinking>end",
        },
      }),
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ]);
    const thinkingStarts = parsed.filter(
      (p) => (p.data?.content_block as { type?: string })?.type === "thinking",
    );
    const textStarts = parsed.filter(
      (p) => (p.data?.content_block as { type?: string })?.type === "text",
    );
    const thinkingText = parsed
      .filter(
        (p) => (p.data?.delta as { type?: string })?.type === "thinking_delta",
      )
      .map((p) => (p.data!.delta as { thinking: string }).thinking)
      .join("");
    const textText = parsed
      .filter(
        (p) => (p.data?.delta as { type?: string })?.type === "text_delta",
      )
      .map((p) => (p.data!.delta as { text: string }).text)
      .join("");
    check(
      "unit-multi: two thinking blocks opened",
      thinkingStarts.length === 2,
      JSON.stringify(thinkingStarts),
    );
    check(
      "unit-multi: one text block (content between/after thinking)",
      textStarts.length === 1,
      JSON.stringify(textStarts),
    );
    check(
      "unit-multi: both reasoning texts captured in order",
      thinkingText === "firstsecond",
      JSON.stringify(thinkingText),
    );
    check(
      "unit-multi: content joined",
      textText === "middleend",
      JSON.stringify(textText),
    );
  }

  // --- Unit test 7: <reasoning> blocks work like <thinking> ---------------
  {
    const parsed = await feedTransform([
      ev("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: "<reasoning>let me analyze</reasoning>final answer",
        },
      }),
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ]);
    const thinkingStarts = parsed.filter(
      (p) => (p.data?.content_block as { type?: string })?.type === "thinking",
    );
    const textStarts = parsed.filter(
      (p) => (p.data?.content_block as { type?: string })?.type === "text",
    );
    const thinkingDeltas = parsed.filter(
      (p) => (p.data?.delta as { type?: string })?.type === "thinking_delta",
    );
    const textDeltas = parsed.filter(
      (p) => (p.data?.delta as { type?: string })?.type === "text_delta",
    );

    check(
      "unit-reasoning: thinking block opened",
      thinkingStarts.length === 1,
      JSON.stringify(thinkingStarts),
    );
    check(
      "unit-reasoning: text block opened after thinking",
      textStarts.length === 1,
      JSON.stringify(textStarts),
    );
    check(
      "unit-reasoning: thinking_delta carries reasoning text",
      thinkingDeltas.length === 1 &&
        (thinkingDeltas[0].data!.delta as { thinking: string }).thinking ===
          "let me analyze",
      JSON.stringify(thinkingDeltas),
    );
    check(
      "unit-reasoning: text_delta carries answer text",
      textDeltas.length === 1 &&
        (textDeltas[0].data!.delta as { text: string }).text === "final answer",
      JSON.stringify(textDeltas),
    );
  }

  // --- Unit test 8: mixed <thinking> and <reasoning> in one stream --------
  {
    const parsed = await feedTransform([
      ev("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: "<thinking>first</thinking>mid<reasoning>second</reasoning>end",
        },
      }),
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ]);
    const thinkingStarts = parsed.filter(
      (p) => (p.data?.content_block as { type?: string })?.type === "thinking",
    );
    const thinkingText = parsed
      .filter(
        (p) => (p.data?.delta as { type?: string })?.type === "thinking_delta",
      )
      .map((p) => (p.data!.delta as { thinking: string }).thinking)
      .join("");
    const textText = parsed
      .filter(
        (p) => (p.data?.delta as { type?: string })?.type === "text_delta",
      )
      .map((p) => (p.data!.delta as { text: string }).text)
      .join("");

    check(
      "unit-mixed-types: two thinking blocks opened",
      thinkingStarts.length === 2,
      JSON.stringify(thinkingStarts),
    );
    check(
      "unit-mixed-types: both reasoning texts captured",
      thinkingText === "firstsecond",
      JSON.stringify(thinkingText),
    );
    check(
      "unit-mixed-types: content joined",
      textText === "midend",
      JSON.stringify(textText),
    );
  }

  // --- Unit test 9: no content_block_* after message_delta/message_stop ----
  // Regression: when the parser holds a partial-tag carry from the last
  // text_delta, _flush() used to emit content_block_delta AFTER message_stop,
  // causing "Received content_block_delta without a current message" on the
  // client. The fix flushes carry at message_delta/message_stop time and
  // suppresses any further block events from _flush.
  {
    const parsed = await feedTransform([
      ev("message_start", {
        type: "message_start",
        message: {
          id: "msg_r",
          role: "assistant",
          content: [],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
      ev("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      // Ends with a partial opening tag — parser holds "<thin" as carry.
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "answer <thin" },
      }),
      // NO content_block_stop — upstream bug / premature end.
      ev("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 3 },
      }),
      ev("message_stop", { type: "message_stop" }),
    ]);

    const messageEndIdx = parsed.findIndex(
      (p) => p.event === "message_delta",
    );
    const afterEnd = parsed.slice(messageEndIdx + 1);
    const lateBlockEvents = afterEnd.filter(
      (p) =>
        p.event === "content_block_start" ||
        p.event === "content_block_delta" ||
        p.event === "content_block_stop",
    );

    check(
      "unit-flush: carry text flushed before message_delta",
      // "answer <thin" — the "answer " part is emitted as content_delta, and
      // "<thin" (partial tag carry) should also be flushed as text before
      // message_delta, not after message_stop.
      parsed
        .slice(0, messageEndIdx)
        .some(
          (p) =>
            (p.data?.delta as { type?: string; text?: string })?.type ===
              "text_delta" &&
            ((p.data!.delta as { text: string }).text ?? "").includes("<thin"),
        ),
      JSON.stringify(
        parsed.map((p) => p.event + ":" + (p.data?.delta as { type?: string })?.type),
      ),
    );
    check(
      "unit-flush: no content_block_* after message_delta",
      lateBlockEvents.length === 0,
      JSON.stringify(lateBlockEvents),
    );
  }

  console.log("\n--- end-to-end Anthropic streaming tests ---");

  // --- End-to-end via real GatewayProxy + mock upstream -------------------
  type PendingHandler = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => void;
  let pending: PendingHandler | null = null;

  const upstream = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      const h = pending;
      pending = null;
      if (!h) {
        res.writeHead(500);
        res.end();
        return;
      }
      h(req, res);
    });
  });

  await new Promise<void>((r) => upstream.listen(0, r));

  const config = loadConfig();
  config.upstream = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

  const logger = new Logger();
  const models = new ModelRegistry(config.models);
  const thinking = new ThinkingConverter();
  const bridge = new ResponsesBridge();
  const proxy = new GatewayProxy(config, logger, models, thinking, bridge);

  const app = express();
  app.use("/v1", express.json({ limit: "100mb" }));
  app.use("/v1", proxy.createMiddleware());

  const gateway = http.createServer(app);
  await new Promise<void>((r) => gateway.listen(0, r));
  const gwPort = (gateway.address() as { port: number }).port;

  function streamRaw(
    res: http.ServerResponse,
    events: string[],
    delayMs = 0,
  ): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    let i = 0;
    const tick = () => {
      if (i >= events.length) {
        res.end();
        return;
      }
      res.write(events[i]);
      i++;
      if (delayMs > 0) setTimeout(tick, delayMs);
      else setImmediate(tick);
    };
    tick();
  }

  async function readAnthropic(resp: Response): Promise<ParsedSse[]> {
    const received: ParsedSse[] = [];
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        received.push(parseSse(raw + "\n\n"));
      }
    }
    return received;
  }

  // E2E 1: full Anthropic stream with one thinking block.
  pending = (_req, res) => {
    streamRaw(res, [
      ev("message_start", {
        type: "message_start",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [],
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      }),
      ev("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      ev("ping", { type: "ping" }),
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "<thinking>plan</thinking>answer" },
      }),
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
      ev("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 7 },
      }),
      ev("message_stop", { type: "message_stop" }),
    ]);
  };
  {
    const r = await fetch(`http://127.0.0.1:${gwPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/gpt-5",
        stream: true,
        messages: [],
        max_tokens: 100,
      }),
    });
    const events = await readAnthropic(r);
    const starts = events.filter((e) => e.event === "content_block_start");
    const thinkingStarts = starts.filter(
      (e) => (e.data?.content_block as { type?: string })?.type === "thinking",
    );
    const textStarts = starts.filter(
      (e) => (e.data?.content_block as { type?: string })?.type === "text",
    );
    const thinkingText = events
      .filter(
        (e) => (e.data?.delta as { type?: string })?.type === "thinking_delta",
      )
      .map((e) => (e.data!.delta as { thinking: string }).thinking)
      .join("");
    const textText = events
      .filter(
        (e) => (e.data?.delta as { type?: string })?.type === "text_delta",
      )
      .map((e) => (e.data!.delta as { text: string }).text)
      .join("");

    check(
      "e2e: thinking block emitted",
      thinkingStarts.length === 1,
      JSON.stringify(starts),
    );
    check(
      "e2e: thinking text preserved",
      thinkingText === "plan",
      JSON.stringify(thinkingText),
    );
    check(
      "e2e: text block emitted after thinking",
      textStarts.length === 1 && (textStarts[0].data!.index as number) === 1,
      JSON.stringify(starts),
    );
    check(
      "e2e: answer text preserved",
      textText === "answer",
      JSON.stringify(textText),
    );
    check(
      "e2e: lifecycle events preserved",
      events.some((e) => e.event === "message_start") &&
        events.some(
          (e) =>
            e.event === "message_delta" &&
            (e.data?.delta as { stop_reason?: string })?.stop_reason ===
              "end_turn",
        ) &&
        events.some((e) => e.event === "message_stop"),
      JSON.stringify(events.map((e) => e.event)),
    );
    check(
      "e2e: ping preserved",
      events.some((e) => e.event === "ping"),
      JSON.stringify(events.map((e) => e.event)),
    );
  }

  // E2E 2: tool_use after thinking, indices remapped correctly.
  pending = (_req, res) => {
    streamRaw(res, [
      ev("message_start", {
        type: "message_start",
        message: {
          id: "msg_2",
          role: "assistant",
          content: [],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
      ev("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: "<thinking>which tool</thinking>using tool",
        },
      }),
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
      ev("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "toolu_abc",
          name: "search",
          input: {},
        },
      }),
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"q":"x"}' },
      }),
      ev("content_block_stop", { type: "content_block_stop", index: 1 }),
      ev("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 12 },
      }),
      ev("message_stop", { type: "message_stop" }),
    ]);
  };
  {
    const r = await fetch(`http://127.0.0.1:${gwPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/gpt-5",
        stream: true,
        messages: [],
        max_tokens: 100,
      }),
    });
    const events = await readAnthropic(r);
    const toolStart = events.find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data?.content_block as { type?: string })?.type === "tool_use",
    );
    const toolDelta = events.find(
      (e) => (e.data?.delta as { type?: string })?.type === "input_json_delta",
    );
    check(
      "e2e-tool: tool_use remapped to index 2",
      toolStart?.data?.index === 2,
      JSON.stringify(toolStart?.data),
    );
    check(
      "e2e-tool: tool_use id/name preserved",
      (toolStart?.data?.content_block as { id?: string; name?: string })?.id ===
        "toolu_abc" &&
        (toolStart?.data?.content_block as { id?: string; name?: string })
          ?.name === "search",
      JSON.stringify(toolStart?.data),
    );
    check(
      "e2e-tool: input_json_delta forwarded on remapped index",
      toolDelta?.data?.index === 2 &&
        (toolDelta!.data!.delta as { partial_json: string }).partial_json ===
          '{"q":"x"}',
      JSON.stringify(toolDelta?.data),
    );
    check(
      "e2e-tool: stop_reason preserved as tool_use",
      events.some(
        (e) =>
          e.event === "message_delta" &&
          (e.data?.delta as { stop_reason?: string })?.stop_reason ===
            "tool_use",
      ),
      JSON.stringify(events.filter((e) => e.event === "message_delta")),
    );
  }

  // E2E 3: timing preserved — events with 100ms gaps arrive ~100ms apart.
  pending = (_req, res) => {
    streamRaw(
      res,
      [
        ev("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        ev("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "<thinking>r</thinking>c1" },
        }),
        ev("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "c2" },
        }),
        ev("content_block_stop", { type: "content_block_stop", index: 0 }),
      ],
      100,
    );
  };
  {
    const t0 = Date.now();
    const arrivalTimes: number[] = [];
    const r = await fetch(`http://127.0.0.1:${gwPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/gpt-5",
        stream: true,
        messages: [],
        max_tokens: 100,
      }),
    });
    const reader = r.body!.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) arrivalTimes.push(Date.now() - t0);
    }
    const gaps: number[] = [];
    for (let i = 1; i < arrivalTimes.length; i++)
      gaps.push(arrivalTimes[i] - arrivalTimes[i - 1]);
    const allAtOnce = gaps.length > 0 && gaps.every((g) => g < 30);
    check(
      "e2e-timing: chunks arrive with gaps preserved (not buffered)",
      !allAtOnce,
      JSON.stringify(gaps),
    );
  }

  await Promise.all([
    new Promise<void>((r) => gateway.close(() => r())),
    new Promise<void>((r) => upstream.close(() => r())),
  ]);
}

main()
  .catch((err) => {
    console.error("FATAL:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    const failed = results.filter((x) => !x.ok);
    console.log(
      "\n" + (failed.length ? failed.length + " FAILED" : "ALL PASS"),
    );
    process.exitCode = process.exitCode || (failed.length ? 1 : 0);
  });
