// End-to-end test for <thinking> conversion through the real proxy stack.
import http from "http";
import express from "express";
import { loadConfig } from "../config";
import { Logger } from "../logger";
import { ModelRegistry } from "../models";
import { ThinkingConverter } from "../thinking";
import { ResponsesBridge } from "../responses-bridge";
import { GatewayProxy } from "../proxy";

// Mock upstream: responds per the `pending` handler, set before each call.
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

function json(res: http.ServerResponse, obj: unknown, status = 200): void {
  const s = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(s),
  });
  res.end(s);
}

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, cond: unknown, detail?: string): void {
  results.push({ name, ok: !!cond });
  console.log(
    (cond ? "PASS" : "FAIL") + " - " + name + (cond ? "" : " :: " + detail),
  );
}

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

  async function call(path: string, body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${gwPort}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // 1) chat/completions single thinking block
  pending = (_req, res) =>
    json(res, {
      id: "c1",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "<thinking>let me think</thinking>Hello there.",
          },
        },
      ],
    });
  {
    const r = await call("/v1/chat/completions", {
      model: "anthropic/gpt-5",
      messages: [],
    });
    const j = (await r.json()) as {
      choices: Array<{
        message: {
          content: string;
          reasoning: string;
          reasoning_details: Array<{
            type: string;
            text: string;
            format: string;
            index: number;
          }>;
        };
      }>;
    };
    const msg = j.choices[0].message;
    check(
      "chat: content stripped",
      msg.content === "Hello there.",
      "got: " + JSON.stringify(msg.content),
    );
    check(
      "chat: reasoning = first block",
      msg.reasoning === "let me think",
      "got: " + JSON.stringify(msg.reasoning),
    );
    check(
      "chat: reasoning_details array",
      Array.isArray(msg.reasoning_details) &&
        msg.reasoning_details[0].type === "reasoning.text" &&
        msg.reasoning_details[0].text === "let me think" &&
        msg.reasoning_details[0].format === "unknown" &&
        msg.reasoning_details[0].index === 0,
      "got: " + JSON.stringify(msg.reasoning_details),
    );
    check(
      "chat: content-type preserved",
      r.headers.get("content-type") === "application/json",
      "got: " + r.headers.get("content-type"),
    );
  }

  // 2) chat/completions NO thinking -> untouched
  pending = (_req, res) =>
    json(res, {
      id: "c2",
      choices: [{ message: { role: "assistant", content: "plain answer" } }],
    });
  {
    const r = await call("/v1/chat/completions", {
      model: "anthropic/gpt-5",
      messages: [],
    });
    const j = (await r.json()) as {
      choices: Array<{ message: { content: string; reasoning?: string } }>;
    };
    check(
      "chat-nothinking: content unchanged",
      j.choices[0].message.content === "plain answer",
      "got: " + JSON.stringify(j.choices[0].message.content),
    );
    check(
      "chat-nothinking: no reasoning added",
      j.choices[0].message.reasoning === undefined,
      "got: " + JSON.stringify(j.choices[0].message.reasoning),
    );
  }

  // 3) /v1/responses with thinking (native-responses passthrough shape)
  pending = (_req, res) =>
    json(res, {
      id: "r_1",
      object: "response",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "<thinking>plan</thinking>Final." },
          ],
        },
      ],
    });
  {
    const r = await call("/v1/responses", {
      model: "anthropic/gpt-5",
      input: "hi",
    });
    const j = (await r.json()) as {
      output: Array<{
        type: string;
        summary?: Array<{ text: string }>;
        content?: Array<{ text: string }>;
      }>;
      reasoning: string;
      reasoning_details: unknown[];
    };
    check(
      "responses: reasoning item prepended",
      j.output[0].type === "reasoning" &&
        j.output[0].summary![0].text === "plan",
      "got: " + JSON.stringify(j.output[0]),
    );
    check(
      "responses: message text stripped",
      j.output[1].content![0].text === "Final.",
      "got: " + JSON.stringify(j.output[1].content![0].text),
    );
    check(
      "responses: top-level reasoning + reasoning_details",
      j.reasoning === "plan" &&
        Array.isArray(j.reasoning_details) &&
        j.reasoning_details.length === 1,
      "got reasoning=" +
        JSON.stringify(j.reasoning) +
        " details=" +
        JSON.stringify(j.reasoning_details),
    );
  }

  // 4) stream:true -> SSE passes through untouched
  pending = (_req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  };
  {
    const r = await call("/v1/chat/completions", {
      model: "anthropic/gpt-5",
      stream: true,
      messages: [],
    });
    const text = await r.text();
    check(
      "stream: SSE passes through",
      r.headers.get("content-type") === "text/event-stream" &&
        text.includes("[DONE]"),
      "ct=" + r.headers.get("content-type") + " body=" + JSON.stringify(text),
    );
  }

  // 5) upstream non-2xx -> status + body passed through, NOT converted
  pending = (_req, res) =>
    json(res, { error: { message: "upstream broken" } }, 500);
  {
    const r = await call("/v1/chat/completions", {
      model: "anthropic/gpt-5",
      messages: [],
    });
    const j = (await r.json()) as { error: { message: string } };
    check(
      "upstream-error: status + body passed through",
      r.status === 500 && j.error.message === "upstream broken",
      "status=" + r.status + " body=" + JSON.stringify(j),
    );
  }

  // 6) chat/completions with multiple thinking blocks
  pending = (_req, res) =>
    json(res, {
      choices: [
        {
          message: {
            role: "assistant",
            content: "<thinking>a</thinking>mid<thinking>b</thinking>end",
          },
        },
      ],
    });
  {
    const r = await call("/v1/chat/completions", {
      model: "anthropic/gpt-5",
      messages: [],
    });
    const j = (await r.json()) as {
      choices: Array<{
        message: {
          content: string;
          reasoning: string;
          reasoning_details: Array<{ index: number; text: string }>;
        };
      }>;
    };
    const msg = j.choices[0].message;
    check(
      "chat-multi: reasoning = first",
      msg.reasoning === "a",
      "got: " + JSON.stringify(msg.reasoning),
    );
    check(
      "chat-multi: two details entries",
      msg.reasoning_details && msg.reasoning_details.length === 2,
      "got: " + JSON.stringify(msg.reasoning_details),
    );
    check(
      "chat-multi: indices increment",
      msg.reasoning_details[0].index === 0 &&
        msg.reasoning_details[1].index === 1 &&
        msg.reasoning_details[0].text === "a" &&
        msg.reasoning_details[1].text === "b",
      "got: " + JSON.stringify(msg.reasoning_details),
    );
    check(
      "chat-multi: content joined",
      msg.content === "midend",
      "got: " + JSON.stringify(msg.content),
    );
  }

  // 7) chat/completions strips leading/trailing whitespace from each block
  pending = (_req, res) =>
    json(res, {
      choices: [
        {
          message: {
            role: "assistant",
            content:
              "<thinking>\n\n  first reason  \n</thinking>answer<thinking>\n\tsecond\n</thinking>",
          },
        },
      ],
    });
  {
    const r = await call("/v1/chat/completions", {
      model: "anthropic/gpt-5",
      messages: [],
    });
    const j = (await r.json()) as {
      choices: Array<{
        message: {
          content: string;
          reasoning: string;
          reasoning_details: Array<{ index: number; text: string }>;
        };
      }>;
    };
    const msg = j.choices[0].message;
    check(
      "chat-ws: reasoning is first block with whitespace stripped",
      msg.reasoning === "first reason",
      "got: " + JSON.stringify(msg.reasoning),
    );
    check(
      "chat-ws: both blocks have whitespace stripped in details",
      msg.reasoning_details[0].text === "first reason" &&
        msg.reasoning_details[1].text === "second",
      "got: " + JSON.stringify(msg.reasoning_details),
    );
    check(
      "chat-ws: content has answer only",
      msg.content === "answer",
      "got: " + JSON.stringify(msg.content),
    );
  }

  // 8) chat/completions with <reasoning> blocks
  pending = (_req, res) =>
    json(res, {
      choices: [
        {
          message: {
            role: "assistant",
            content: "<reasoning>analyze this</reasoning>Result",
          },
        },
      ],
    });
  {
    const r = await call("/v1/chat/completions", {
      model: "anthropic/gpt-5",
      messages: [],
    });
    const j = (await r.json()) as {
      choices: Array<{
        message: {
          content: string;
          reasoning: string;
          reasoning_details: Array<{
            type: string;
            text: string;
            index: number;
          }>;
        };
      }>;
    };
    const msg = j.choices[0].message;
    check(
      "chat-reasoning: content stripped",
      msg.content === "Result",
      "got: " + JSON.stringify(msg.content),
    );
    check(
      "chat-reasoning: reasoning = first block",
      msg.reasoning === "analyze this",
      "got: " + JSON.stringify(msg.reasoning),
    );
    check(
      "chat-reasoning: reasoning_details",
      msg.reasoning_details[0].text === "analyze this",
      "got: " + JSON.stringify(msg.reasoning_details),
    );
  }

  // 9) chat/completions with <think> blocks
  pending = (_req, res) =>
    json(res, {
      choices: [
        {
          message: {
            role: "assistant",
            content: "<think>short reasoning</think>Answer",
          },
        },
      ],
    });
  {
    const r = await call("/v1/chat/completions", {
      model: "anthropic/gpt-5",
      messages: [],
    });
    const j = (await r.json()) as {
      choices: Array<{ message: { content: string; reasoning: string } }>;
    };
    const msg = j.choices[0].message;
    check(
      "chat-think-short: content stripped",
      msg.content === "Answer",
      "got: " + JSON.stringify(msg.content),
    );
    check(
      "chat-think-short: reasoning extracted",
      msg.reasoning === "short reasoning",
      "got: " + JSON.stringify(msg.reasoning),
    );
  }

  // 10) chat/completions with unclosed <thinking> (model stuck) — tag stripped, content preserved
  pending = (_req, res) =>
    json(res, {
      choices: [
        { message: { role: "assistant", content: "<think>stuck reasoning" } },
      ],
    });
  {
    const r = await call("/v1/chat/completions", {
      model: "anthropic/gpt-5",
      messages: [],
    });
    const j = (await r.json()) as {
      choices: Array<{ message: { content: string; reasoning?: string } }>;
    };
    const msg = j.choices[0].message;
    check(
      "chat-unclosed: unclosed tag stripped from content",
      !msg.content.includes("<think>"),
      "got: " + JSON.stringify(msg.content),
    );
    check(
      "chat-unclosed: no reasoning from unclosed block",
      msg.reasoning === undefined,
      "got: " + JSON.stringify(msg.reasoning),
    );
  }

  // 11) chat/completions with unclosed <reasoning> at start — tag stripped
  pending = (_req, res) =>
    json(res, {
      choices: [
        { message: { role: "assistant", content: "<reasoning>stuck" } },
      ],
    });
  {
    const r = await call("/v1/chat/completions", {
      model: "anthropic/gpt-5",
      messages: [],
    });
    const j = (await r.json()) as {
      choices: Array<{ message: { content: string; reasoning?: string } }>;
    };
    const msg = j.choices[0].message;
    check(
      "chat-unclosed-reasoning: tag stripped",
      !msg.content.includes("<reasoning>"),
      "got: " + JSON.stringify(msg.content),
    );
    check(
      "chat-unclosed-reasoning: no reasoning from unclosed block",
      msg.reasoning === undefined,
      "got: " + JSON.stringify(msg.reasoning),
    );
  }

  // 12) chat/completions with whitespace in tags
  pending = (_req, res) =>
    json(res, {
      choices: [
        {
          message: {
            role: "assistant",
            content: "< thinking >ws reasoning< /thinking >ws answer",
          },
        },
      ],
    });
  {
    const r = await call("/v1/chat/completions", {
      model: "anthropic/gpt-5",
      messages: [],
    });
    const j = (await r.json()) as {
      choices: Array<{ message: { content: string; reasoning: string } }>;
    };
    const msg = j.choices[0].message;
    check(
      "chat-whitespace-tags: content stripped",
      msg.content === "ws answer",
      "got: " + JSON.stringify(msg.content),
    );
    check(
      "chat-whitespace-tags: reasoning extracted",
      msg.reasoning === "ws reasoning",
      "got: " + JSON.stringify(msg.reasoning),
    );
  }

  // 13) /v1/responses with <reasoning> blocks
  pending = (_req, res) =>
    json(res, {
      id: "r_2",
      object: "response",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "<reasoning>analyze</reasoning>Done.",
            },
          ],
        },
      ],
    });
  {
    const r = await call("/v1/responses", {
      model: "anthropic/gpt-5",
      input: "hi",
    });
    const j = (await r.json()) as {
      output: Array<{
        type: string;
        summary?: Array<{ text: string }>;
        content?: Array<{ text: string }>;
      }>;
      reasoning: string;
    };
    check(
      "responses-reasoning: reasoning item prepended",
      j.output[0].type === "reasoning" &&
        j.output[0].summary![0].text === "analyze",
      "got: " + JSON.stringify(j.output[0]),
    );
    check(
      "responses-reasoning: message text stripped",
      j.output[1].content![0].text === "Done.",
      "got: " + JSON.stringify(j.output[1].content![0].text),
    );
  }

  // 14) chat/completions with mixed thinking and reasoning blocks
  pending = (_req, res) =>
    json(res, {
      choices: [
        {
          message: {
            role: "assistant",
            content: "<thinking>a</thinking>mid<reasoning>b</reasoning>end",
          },
        },
      ],
    });
  {
    const r = await call("/v1/chat/completions", {
      model: "anthropic/gpt-5",
      messages: [],
    });
    const j = (await r.json()) as {
      choices: Array<{
        message: {
          content: string;
          reasoning: string;
          reasoning_details: Array<{ index: number; text: string }>;
        };
      }>;
    };
    const msg = j.choices[0].message;
    check(
      "chat-mixed: reasoning = first block",
      msg.reasoning === "a",
      "got: " + JSON.stringify(msg.reasoning),
    );
    check(
      "chat-mixed: two details entries",
      msg.reasoning_details && msg.reasoning_details.length === 2,
      "got: " + JSON.stringify(msg.reasoning_details),
    );
    check(
      "chat-mixed: indices increment",
      msg.reasoning_details[0].index === 0 &&
        msg.reasoning_details[1].index === 1 &&
        msg.reasoning_details[0].text === "a" &&
        msg.reasoning_details[1].text === "b",
      "got: " + JSON.stringify(msg.reasoning_details),
    );
    check(
      "chat-mixed: content joined",
      msg.content === "midend",
      "got: " + JSON.stringify(msg.content),
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
