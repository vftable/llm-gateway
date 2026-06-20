// End-to-end test for streaming <thinking> conversion on /v1/chat/completions.
// Verifies that:
//   1. <thinking>...</thinking> in a streaming response is moved out of
//      delta.content and into delta.reasoning_content
//   2. Tag boundaries split across upstream chunks are handled (the parser
//      holds back a partial tag and resolves it once the rest arrives)
//   3. Multiple thinking blocks in one stream work
//   4. Streams with no <thinking> at all pass through unchanged
//   5. SSE arrival timing is preserved (we don't buffer until end-of-stream)

import http from "http";
import express from "express";
import { loadConfig } from "../config";
import { Logger } from "../logger";
import { ModelRegistry } from "../models";
import { ThinkingConverter } from "../thinking";
import { ResponsesBridge } from "../responses-bridge";
import { GatewayProxy } from "../proxy";
import { StreamingThinkingParser } from "../streaming-thinking";

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, cond: unknown, detail?: string): void {
  results.push({ name, ok: !!cond });
  console.log(
    (cond ? "PASS" : "FAIL") + " - " + name + (cond ? "" : " :: " + detail),
  );
}

// --- Pure-parser unit tests -------------------------------------------------
// Cover tag splits that the e2e test would also exercise, but in isolation so
// a failure pinpoints the parser from the SSE plumbing.
{
  const p = new StreamingThinkingParser();
  // "<thi" + "nking>reason</thin" + "king>body"
  const a = p.feed("<thi");
  const b = p.feed("nking>reason</thin");
  const c = p.feed("king>body");
  check(
    "parser: partial open tag held then flushed",
    a.content === "" &&
      a.reasoning === "" &&
      b.content === "" &&
      b.reasoning === "reason" &&
      c.content === "body" &&
      c.reasoning === "",
    JSON.stringify({ a, b, c }),
  );
}

{
  const p = new StreamingThinkingParser();
  // Two blocks separated by content, all in one feed.
  const out = p.feed("<thinking>a</thinking>mid<thinking>b</thinking>tail");
  check(
    "parser: two blocks in one feed",
    out.content === "midtail" && out.reasoning === "ab",
    JSON.stringify(out),
  );
}

{
  const p = new StreamingThinkingParser();
  // No thinking — straight passthrough.
  const out = p.feed("just a regular answer, nothing to see here");
  check(
    "parser: no thinking passthrough",
    out.content === "just a regular answer, nothing to see here" &&
      out.reasoning === "",
    JSON.stringify(out),
  );
}

{
  const p = new StreamingThinkingParser();
  // Stream ends mid-tag — flush should emit the carry as content (best effort).
  p.feed("hello <thi");
  const flushed = p.flush();
  check(
    "parser: flush emits carry as content",
    flushed.content === "<thi" && flushed.reasoning === "",
    JSON.stringify(flushed),
  );
}

{
  const p = new StreamingThinkingParser();
  // Stream ends with partial closing tag inside thinking block.
  // The feed() call emits the reasoning text; flush() discards the partial tag.
  p.feed("<thinking>");
  const fed = p.feed("some reasoning</think");
  const flushed = p.flush();
  check(
    "parser: flush discards partial closing tag",
    fed.reasoning === "some reasoning" &&
      flushed.reasoning === "" &&
      !flushed.reasoning.includes("</"),
    JSON.stringify({ fed, flushed }),
  );
}

{
  const p = new StreamingThinkingParser();
  // Stream ends with just `</` inside thinking block.
  // Should emit nothing — it's all partial tag.
  p.feed("<thinking>");
  p.feed("</");
  const flushed = p.flush();
  check(
    "parser: flush discards lone partial closing tag",
    flushed.reasoning === "" && flushed.content === "",
    JSON.stringify(flushed),
  );
}

{
  const p = new StreamingThinkingParser();
  // Tricky: text ending in "<" that is NOT the start of a tag.
  const out = p.feed("3 < 4 and 5 > 2");
  check(
    "parser: bare < and > pass through",
    out.content === "3 < 4 and 5 > 2" && out.reasoning === "",
    JSON.stringify(out),
  );
}

{
  const p = new StreamingThinkingParser();
  // Leading whitespace after <thinking> should be stripped from the first
  // emitted reasoning chunk — including when the whitespace arrives in a
  // later chunk than the opening tag.
  const a = p.feed("<thinking>");
  const b = p.feed("\n\n   let me think");
  const c = p.feed(" more text</thinking>body");
  check(
    "parser: leading whitespace stripped at block start",
    a.reasoning === "" &&
      b.reasoning === "let me think" &&
      c.reasoning === " more text",
    JSON.stringify({ a, b, c }),
  );
}

{
  const p = new StreamingThinkingParser();
  // Multiple blocks in a stream — each gets its own index in reasoning_details,
  // and leading whitespace is stripped independently for each block.
  const a = p.feed("<thinking>\nfirst</thinking>middle");
  const b = p.feed("<thinking>\n  second</thinking>end");
  check(
    "parser: multiple blocks get distinct indices",
    a.reasoningDetails.length === 1 &&
      a.reasoningDetails[0].index === 0 &&
      a.reasoningDetails[0].text === "first" &&
      b.reasoningDetails.length === 1 &&
      b.reasoningDetails[0].index === 1 &&
      b.reasoningDetails[0].text === "second",
    JSON.stringify({ a: a.reasoningDetails, b: b.reasoningDetails }),
  );
  check(
    "parser: each block strips its own leading whitespace",
    a.reasoning === "first" && b.reasoning === "second",
    JSON.stringify({ a: a.reasoning, b: b.reasoning }),
  );
}

{
  const p = new StreamingThinkingParser();
  // A single chunk that spans an entire block boundary: close + open in one
  // delta should emit two reasoning_details entries with different indices.
  const out = p.feed("<thinking>a</thinking>x<thinking>b</thinking>y");
  check(
    "parser: spanned blocks emit multi-entry reasoningDetails",
    out.reasoningDetails.length === 2 &&
      out.reasoningDetails[0].index === 0 &&
      out.reasoningDetails[0].text === "a" &&
      out.reasoningDetails[1].index === 1 &&
      out.reasoningDetails[1].text === "b",
    JSON.stringify(out.reasoningDetails),
  );
  check(
    "parser: spanned blocks content joined",
    out.content === "xy" && out.reasoning === "ab",
    JSON.stringify({ content: out.content, reasoning: out.reasoning }),
  );
}

// --- Literal thinking tag tests ----------------------------------------------
// Models may emit literal <thinking> or </thinking> as part of their reasoning.
// These must be handled gracefully without corrupting the stream.

{
  const p = new StreamingThinkingParser();
  // Literal <thinking> tag inside a thinking block should be treated as text.
  const out = p.feed("<thinking>hello <thinking> world</thinking>");
  check(
    "parser: literal <thinking> inside block is text",
    out.reasoning === "hello <thinking> world" && out.content === "",
    JSON.stringify(out),
  );
}

{
  const p = new StreamingThinkingParser();
  // Literal </thinking> inside thinking block closes it — that's the spec.
  // The model "broke out" of the block, so we respect that.
  const out = p.feed("<thinking>hello </thinking> world</thinking>");
  check(
    "parser: literal </thinking> inside block closes it",
    out.reasoning === "hello " && out.content === " world</thinking>",
    JSON.stringify(out),
  );
}

{
  const p = new StreamingThinkingParser();
  // Literal tags split across chunks: <thin + king> inside thinking block.
  const a = p.feed("<thinking>hello <thin");
  const b = p.feed("king> world</thinking>");
  check(
    "parser: literal <thinking> split across chunks",
    a.reasoning === "hello <thin" && b.reasoning === "king> world",
    JSON.stringify({ a, b }),
  );
}

{
  const p = new StreamingThinkingParser();
  // Closing tag split: </thin + king> — first chunk held, second closes block.
  const a = p.feed("<thinking>reasoning </thin");
  const b = p.feed("king> after</thinking>content");
  check(
    "parser: </thinking> split across chunks closes correctly",
    a.reasoning === "reasoning " &&
      b.reasoning === "" &&
      b.content === " after</thinking>content",
    JSON.stringify({ a, b }),
  );
}

{
  const p = new StreamingThinkingParser();
  // Multiple literal <thinking> tags in sequence — all treated as text.
  const out = p.feed("<thinking>a <thinking> b <thinking> c</thinking>");
  check(
    "parser: multiple literal <thinking> tags are text",
    out.reasoning === "a <thinking> b <thinking> c" && out.content === "",
    JSON.stringify(out),
  );
}

{
  const p = new StreamingThinkingParser();
  // Mixed: literal open tag, then real close tag, then more content.
  const out = p.feed("<thinking>think <thinking> more</thinking> done");
  check(
    "parser: literal open + real close then content",
    out.reasoning === "think <thinking> more" && out.content === " done",
    JSON.stringify(out),
  );
}

{
  const p = new StreamingThinkingParser();
  // Content state: literal </thinking> is just text, not a tag.
  const out = p.feed("hello </thinking> world");
  check(
    "parser: </thinking> in content state is text",
    out.content === "hello </thinking> world" && out.reasoning === "",
    JSON.stringify(out),
  );
}

{
  const p = new StreamingThinkingParser();
  // Content state: literal <thinking> opens a block.
  const out = p.feed("before <thinking>reason</thinking> after");
  check(
    "parser: <thinking> in content state opens block",
    out.content === "before  after" && out.reasoning === "reason",
    JSON.stringify(out),
  );
}

{
  const p = new StreamingThinkingParser();
  // Edge case: thinking block with only a literal closing tag, no real content.
  const out = p.feed("<thinking></thinking>");
  check(
    "parser: empty thinking block with literal close",
    out.reasoning === "" && out.content === "",
    JSON.stringify(out),
  );
}

{
  const p = new StreamingThinkingParser();
  // Edge case: consecutive close tags — first closes, rest is content.
  const out = p.feed("<thinking>reasoning</thinking></thinking>tail");
  check(
    "parser: double close tag",
    out.reasoning === "reasoning" && out.content === "</thinking>tail",
    JSON.stringify(out),
  );
}

{
  const p = new StreamingThinkingParser();
  // Edge case: open tag immediately followed by close tag.
  const out = p.feed("<thinking></thinking>content");
  check(
    "parser: open immediately followed by close",
    out.reasoning === "" && out.content === "content",
    JSON.stringify(out),
  );
}

// --- <reasoning> tag tests ---------------------------------------------------

{
  const p = new StreamingThinkingParser();
  // Basic <reasoning> block.
  const out = p.feed("<reasoning>thought</reasoning>answer");
  check(
    "parser-reasoning: basic block",
    out.reasoning === "thought" && out.content === "answer",
    JSON.stringify(out),
  );
}

{
  const p = new StreamingThinkingParser();
  // <reasoning> block split across chunks.
  const a = p.feed("<reas");
  const b = p.feed("oning>thought</reas");
  const c = p.feed("oning>answer");
  check(
    "parser-reasoning: split across chunks",
    a.reasoning === "" &&
      a.content === "" &&
      b.reasoning === "thought" &&
      c.content === "answer" &&
      c.reasoning === "",
    JSON.stringify({ a, b, c }),
  );
}

{
  const p = new StreamingThinkingParser();
  // Multiple <reasoning> blocks.
  const out = p.feed(
    "<reasoning>first</reasoning>mid<reasoning>second</reasoning>end",
  );
  check(
    "parser-reasoning: multiple blocks",
    out.reasoning === "firstsecond" && out.content === "midend",
    JSON.stringify(out),
  );
}

{
  const p = new StreamingThinkingParser();
  // Mixed <thinking> and <reasoning> blocks.
  const out = p.feed("<thinking>a</thinking>mid<reasoning>b</reasoning>end");
  check(
    "parser-mixed: thinking + reasoning",
    out.reasoning === "ab" && out.content === "midend",
    JSON.stringify(out),
  );
}

{
  const p = new StreamingThinkingParser();
  // Unclosed <reasoning> — stream ends mid-block.
  // feed() emits the reasoning immediately; flush() has nothing left.
  const fed = p.feed("<reasoning>stuck");
  const flushed = p.flush();
  check(
    "parser-reasoning: unclosed block emitted in feed",
    fed.reasoning === "stuck" && fed.content === "",
    JSON.stringify(fed),
  );
  check(
    "parser-reasoning: flush is empty after feed",
    flushed.reasoning === "" && flushed.content === "",
    JSON.stringify(flushed),
  );
}

{
  const p = new StreamingThinkingParser();
  // Leading whitespace stripped from <reasoning> block.
  const a = p.feed("<reasoning>");
  const b = p.feed("\n  thought");
  check(
    "parser-reasoning: leading whitespace stripped",
    a.reasoning === "" && b.reasoning === "thought",
    JSON.stringify({ a, b }),
  );
}

// --- <think> short tag tests ---------------------------------------------------

{
  const p = new StreamingThinkingParser();
  // Basic <think> block.
  const out = p.feed("<think>thought</think>answer");
  check(
    "parser-think-short: basic block",
    out.reasoning === "thought" && out.content === "answer",
    JSON.stringify(out),
  );
}

{
  const p = new StreamingThinkingParser();
  // <think> split across chunks.
  const a = p.feed("<think>");
  const b = p.feed("thought</thin");
  const c = p.feed("king>answer");
  check(
    "parser-think-short: split across chunks",
    a.reasoning === "" && b.reasoning === "thought" && c.content === "answer",
    JSON.stringify({ a, b, c }),
  );
}

console.log("\n--- end-to-end streaming tests ---");

// --- End-to-end via real GatewayProxy + mock upstream -----------------------
type PendingHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Record<string, unknown>,
) => void;
let pending: PendingHandler | null = null;

const upstream = http.createServer((req, res) => {
  let buf = "";
  req.on("data", (c) => (buf += c));
  req.on("end", () => {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(buf || "{}");
    } catch (_) {
      /* keep empty */
    }
    const h = pending;
    pending = null;
    if (!h) {
      res.writeHead(500);
      res.end();
      return;
    }
    h(req, res, body);
  });
});

upstream.listen(0, async () => {
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

  // Stream a sequence of `data: {chunk}\n\n` events with optional delay.
  function streamEvents(
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
      else tick();
    };
    tick();
  }

  // Build a chat-completion chunk delta.
  function chunk(content: string, extra: Record<string, unknown> = {}): string {
    const payload = {
      id: "chatcmpl-x",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "test",
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
      ...extra,
    };
    return "data: " + JSON.stringify(payload) + "\n\n";
  }

  const DONE = "data: [DONE]\n\n";

  // Read the full client-side stream into a list of {content, reasoning, ...} deltas.
  type ReasoningDetail = {
    type: string;
    text: string;
    format: string;
    index: number;
  };
  async function readStream(
    resp: Response,
  ): Promise<
    Array<{
      content: string;
      reasoning: string;
      reasoningDetails: ReasoningDetail[];
      done: boolean;
    }>
  > {
    const received: Array<{
      content: string;
      reasoning: string;
      reasoningDetails: ReasoningDetail[];
      done: boolean;
    }> = [];
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLines = event
          .split("\n")
          .filter((l) => l.startsWith("data:"));
        if (dataLines.length === 0) continue;
        const data = dataLines
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data === "[DONE]") {
          received.push({
            content: "",
            reasoning: "",
            reasoningDetails: [],
            done: true,
          });
          continue;
        }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta || {};
          received.push({
            content: typeof delta.content === "string" ? delta.content : "",
            reasoning:
              typeof delta.reasoning_content === "string"
                ? delta.reasoning_content
                : "",
            reasoningDetails: Array.isArray(delta.reasoning_details)
              ? delta.reasoning_details
              : [],
            done: false,
          });
        } catch {
          /* ignore */
        }
      }
    }
    return received;
  }

  // 1) Single thinking block split across multiple chunks, no delay.
  pending = (_req, res) => {
    streamEvents(res, [
      chunk("<thi"),
      chunk("nking>let me think</thin"),
      chunk("king>final answer"),
      DONE,
    ]);
  };
  {
    const r = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/gpt-5",
        stream: true,
        messages: [],
      }),
    });
    const events = await readStream(r);
    const content = events
      .filter((e) => !e.done)
      .map((e) => e.content)
      .join("");
    const reasoning = events
      .filter((e) => !e.done)
      .map((e) => e.reasoning)
      .join("");
    check(
      "stream: content has no thinking tags",
      !content.includes("<thinking>") && !content.includes("</thinking>"),
      JSON.stringify(content),
    );
    check(
      "stream: content has the answer text",
      content === "final answer",
      JSON.stringify(content),
    );
    check(
      "stream: reasoning_content has the reasoning text",
      reasoning === "let me think",
      JSON.stringify(reasoning),
    );
    check(
      "stream: [DONE] preserved",
      events.some((e) => e.done),
      JSON.stringify(events.length),
    );
    check(
      "stream: content-type preserved",
      r.headers.get("content-type") === "text/event-stream",
      String(r.headers.get("content-type")),
    );
  }

  // 2) Two thinking blocks in one stream.
  pending = (_req, res) => {
    streamEvents(res, [
      chunk("<thinking>block one</thinking>middle"),
      chunk("<thinking>block two</thinking>end"),
      DONE,
    ]);
  };
  {
    const r = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/gpt-5",
        stream: true,
        messages: [],
      }),
    });
    const events = await readStream(r);
    const content = events
      .filter((e) => !e.done)
      .map((e) => e.content)
      .join("");
    const reasoning = events
      .filter((e) => !e.done)
      .map((e) => e.reasoning)
      .join("");
    check(
      "stream-multi: two reasoning blocks concatenated",
      reasoning === "block oneblock two",
      JSON.stringify(reasoning),
    );
    check(
      "stream-multi: middle+end content preserved",
      content === "middleend",
      JSON.stringify(content),
    );
    // Gather all reasoning_details entries the client saw, in order.
    const allDetails = events.flatMap((e) => e.reasoningDetails);
    const blockOneText = allDetails
      .filter((d) => d.index === 0)
      .map((d) => d.text)
      .join("");
    const blockTwoText = allDetails
      .filter((d) => d.index === 1)
      .map((d) => d.text)
      .join("");
    check(
      "stream-multi: reasoning_details emitted with per-block indices",
      blockOneText === "block one" && blockTwoText === "block two",
      JSON.stringify(allDetails),
    );
  }

  // 2b) Leading whitespace stripped from the start of each reasoning block,
  //     including when the whitespace lands in a separate chunk from the
  //     opening tag and when blocks are split across many deltas.
  pending = (_req, res) => {
    streamEvents(res, [
      chunk("<thinking>"),
      chunk("\n\n   first reason"),
      chunk(" continued</thinking>answer"),
      chunk("<thinking>\n  second reason</thinking>tail"),
      DONE,
    ]);
  };
  {
    const r = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/gpt-5",
        stream: true,
        messages: [],
      }),
    });
    const events = await readStream(r);
    const reasoning = events
      .filter((e) => !e.done)
      .map((e) => e.reasoning)
      .join("");
    const content = events
      .filter((e) => !e.done)
      .map((e) => e.content)
      .join("");
    check(
      "stream-ws: leading whitespace stripped per block",
      reasoning === "first reason continuedsecond reason",
      JSON.stringify(reasoning),
    );
    // The FIRST delta emitted for each block index must have no leading
    // whitespace; later continuation deltas within the same block legitimately
    // can (the space joining "first reason" and "continued" is meaningful).
    const firstDeltaByIndex = new Map<number, string>();
    for (const e of events) {
      for (const d of e.reasoningDetails) {
        if (!firstDeltaByIndex.has(d.index))
          firstDeltaByIndex.set(d.index, d.text);
      }
    }
    check(
      "stream-ws: first delta of each block has no leading whitespace",
      Array.from(firstDeltaByIndex.values()).every((t) => !/^\s/.test(t)),
      JSON.stringify(Array.from(firstDeltaByIndex.entries())),
    );
    check(
      "stream-ws: content deltas preserved",
      content === "answertail",
      JSON.stringify(content),
    );
    const allDetails = events.flatMap((e) => e.reasoningDetails);
    const blockOneText = allDetails
      .filter((d) => d.index === 0)
      .map((d) => d.text)
      .join("");
    const blockTwoText = allDetails
      .filter((d) => d.index === 1)
      .map((d) => d.text)
      .join("");
    check(
      "stream-ws: reasoning_details per-block text correct",
      blockOneText === "first reason continued" &&
        blockTwoText === "second reason",
      JSON.stringify(allDetails),
    );
  }

  // 3) No thinking at all — content deltas pass through verbatim.
  pending = (_req, res) => {
    streamEvents(res, [chunk("hello "), chunk("world"), DONE]);
  };
  {
    const r = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/gpt-5",
        stream: true,
        messages: [],
      }),
    });
    const events = await readStream(r);
    const content = events
      .filter((e) => !e.done)
      .map((e) => e.content)
      .join("");
    const anyReasoning = events.some((e) => e.reasoning.length > 0);
    check(
      "stream-nothink: content passthrough",
      content === "hello world",
      JSON.stringify(content),
    );
    check(
      "stream-nothink: no reasoning deltas emitted",
      !anyReasoning,
      JSON.stringify(events),
    );
  }

  // 4) Timing preserved — events with 100ms gaps should arrive ~100ms apart,
  //    proving we don't buffer the whole stream before emitting.
  pending = (_req, res) => {
    streamEvents(
      res,
      [chunk("<thinking>r</thinking>c1"), chunk("c2"), DONE],
      100,
    );
  };
  {
    const t0 = Date.now();
    const arrivalTimes: number[] = [];
    const r = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/gpt-5",
        stream: true,
        messages: [],
      }),
    });
    const reader = r.body!.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) arrivalTimes.push(Date.now() - t0);
    }
    const gaps = [];
    for (let i = 1; i < arrivalTimes.length; i++)
      gaps.push(arrivalTimes[i] - arrivalTimes[i - 1]);
    const allAtOnce = gaps.length > 0 && gaps.every((g) => g < 30);
    check(
      "stream-timing: chunks arrive with gaps preserved (not buffered)",
      !allAtOnce,
      JSON.stringify(gaps),
    );
  }

  // 5) Literal <thinking> tag inside thinking block — should pass through as text.
  pending = (_req, res) => {
    streamEvents(res, [
      chunk("<thinking>hello <thinking> world</thinking>answer"),
      DONE,
    ]);
  };
  {
    const r = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/gpt-5",
        stream: true,
        messages: [],
      }),
    });
    const events = await readStream(r);
    const content = events
      .filter((e) => !e.done)
      .map((e) => e.content)
      .join("");
    const reasoning = events
      .filter((e) => !e.done)
      .map((e) => e.reasoning)
      .join("");
    check(
      "stream-literal: literal <thinking> in block becomes reasoning text",
      reasoning === "hello <thinking> world",
      JSON.stringify({ reasoning, content }),
    );
    check(
      "stream-literal: content after close is correct",
      content === "answer",
      JSON.stringify(content),
    );
  }

  // 6) Literal </thinking> closes the block — model "broke out" intentionally.
  pending = (_req, res) => {
    streamEvents(res, [
      chunk("<thinking>reasoning </thinking> actual content"),
      DONE,
    ]);
  };
  {
    const r = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/gpt-5",
        stream: true,
        messages: [],
      }),
    });
    const events = await readStream(r);
    const content = events
      .filter((e) => !e.done)
      .map((e) => e.content)
      .join("");
    const reasoning = events
      .filter((e) => !e.done)
      .map((e) => e.reasoning)
      .join("");
    check(
      "stream-literal: first </thinking> closes block",
      reasoning === "reasoning ",
      JSON.stringify(reasoning),
    );
    check(
      "stream-literal: remaining text is content",
      content.includes("actual content"),
      JSON.stringify(content),
    );
  }

  // 7) Split literal tags across chunks — partial <thin held, then completed.
  pending = (_req, res) => {
    streamEvents(res, [
      chunk("<thinking>text <thin"),
      chunk("king> more</thinking>end"),
      DONE,
    ]);
  };
  {
    const r = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/gpt-5",
        stream: true,
        messages: [],
      }),
    });
    const events = await readStream(r);
    const content = events
      .filter((e) => !e.done)
      .map((e) => e.content)
      .join("");
    const reasoning = events
      .filter((e) => !e.done)
      .map((e) => e.reasoning)
      .join("");
    check(
      "stream-literal: split literal <thinking> preserved",
      reasoning.includes("text <thinking> more"),
      JSON.stringify({ reasoning, content }),
    );
    check(
      "stream-literal: content after block",
      content === "end",
      JSON.stringify(content),
    );
  }

  // 8) <reasoning> block in stream
  pending = (_req, res) => {
    streamEvents(res, [
      chunk("<reasoning>let me analyze</reasoning>Here is the answer"),
      DONE,
    ]);
  };
  {
    const r = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/gpt-5",
        stream: true,
        messages: [],
      }),
    });
    const events = await readStream(r);
    const content = events
      .filter((e) => !e.done)
      .map((e) => e.content)
      .join("");
    const reasoning = events
      .filter((e) => !e.done)
      .map((e) => e.reasoning)
      .join("");
    check(
      "stream-reasoning: content has no reasoning tags",
      !content.includes("<reasoning>"),
      JSON.stringify(content),
    );
    check(
      "stream-reasoning: content is the answer",
      content === "Here is the answer",
      JSON.stringify(content),
    );
    check(
      "stream-reasoning: reasoning_content has the reasoning",
      reasoning === "let me analyze",
      JSON.stringify(reasoning),
    );
  }

  // 9) <think> block in stream
  pending = (_req, res) => {
    streamEvents(res, [chunk("<think>short thought</think>Final"), DONE]);
  };
  {
    const r = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/gpt-5",
        stream: true,
        messages: [],
      }),
    });
    const events = await readStream(r);
    const content = events
      .filter((e) => !e.done)
      .map((e) => e.content)
      .join("");
    const reasoning = events
      .filter((e) => !e.done)
      .map((e) => e.reasoning)
      .join("");
    check(
      "stream-think-short: content is answer",
      content === "Final",
      JSON.stringify(content),
    );
    check(
      "stream-think-short: reasoning extracted",
      reasoning === "short thought",
      JSON.stringify(reasoning),
    );
  }

  // 10) Unclosed <thinking> block — model stuck, stream ends
  pending = (_req, res) => {
    streamEvents(res, [chunk("<thinking>stuck reasoning"), DONE]);
  };
  {
    const r = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/gpt-5",
        stream: true,
        messages: [],
      }),
    });
    const events = await readStream(r);
    const reasoning = events
      .filter((e) => !e.done)
      .map((e) => e.reasoning)
      .join("");
    const content = events
      .filter((e) => !e.done)
      .map((e) => e.content)
      .join("");
    check(
      "stream-unclosed: reasoning emitted from unclosed block",
      reasoning === "stuck reasoning",
      JSON.stringify(reasoning),
    );
    check(
      "stream-unclosed: no leftover content",
      content === "",
      JSON.stringify(content),
    );
  }

  // 11) Mixed <thinking> and <reasoning> blocks in one stream
  pending = (_req, res) => {
    streamEvents(res, [
      chunk(
        "<thinking>block one</thinking>mid<reasoning>block two</reasoning>end",
      ),
      DONE,
    ]);
  };
  {
    const r = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/gpt-5",
        stream: true,
        messages: [],
      }),
    });
    const events = await readStream(r);
    const content = events
      .filter((e) => !e.done)
      .map((e) => e.content)
      .join("");
    const reasoning = events
      .filter((e) => !e.done)
      .map((e) => e.reasoning)
      .join("");
    check(
      "stream-mixed: both blocks extracted",
      reasoning === "block oneblock two",
      JSON.stringify(reasoning),
    );
    check(
      "stream-mixed: content joined",
      content === "midend",
      JSON.stringify(content),
    );
    const allDetails = events.flatMap((e) => e.reasoningDetails);
    const blockOneText = allDetails
      .filter((d) => d.index === 0)
      .map((d) => d.text)
      .join("");
    const blockTwoText = allDetails
      .filter((d) => d.index === 1)
      .map((d) => d.text)
      .join("");
    check(
      "stream-mixed: reasoning_details with distinct indices",
      blockOneText === "block one" && blockTwoText === "block two",
      JSON.stringify(allDetails),
    );
  }

  // 12) <reasoning> block split across chunks
  pending = (_req, res) => {
    streamEvents(res, [
      chunk("<reas"),
      chunk("oning>thought</reas"),
      chunk("oning>answer"),
      DONE,
    ]);
  };
  {
    const r = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/gpt-5",
        stream: true,
        messages: [],
      }),
    });
    const events = await readStream(r);
    const content = events
      .filter((e) => !e.done)
      .map((e) => e.content)
      .join("");
    const reasoning = events
      .filter((e) => !e.done)
      .map((e) => e.reasoning)
      .join("");
    check(
      "stream-reasoning-split: reasoning reassembled",
      reasoning === "thought",
      JSON.stringify(reasoning),
    );
    check(
      "stream-reasoning-split: content correct",
      content === "answer",
      JSON.stringify(content),
    );
  }

  await Promise.all([
    new Promise<void>((r) => gateway.close(() => r())),
    new Promise<void>((r) => upstream.close(() => r())),
  ]);
  const failed = results.filter((x) => !x.ok);
  console.log("\n" + (failed.length ? failed.length + " FAILED" : "ALL PASS"));
  process.exitCode = failed.length ? 1 : 0;
});
