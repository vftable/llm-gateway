// Repro: non-streaming /v1/messages with inline <think> — is it converted?
import http from "http";
import express from "express";
import { loadConfig } from "../config";
import { Logger } from "../logger";
import { ModelRegistry } from "../models";
import { ThinkingConverter } from "../thinking";
import { ResponsesBridge } from "../responses-bridge";
import { GatewayProxy } from "../proxy";
import { UsageTracker } from "../usage";

async function main(): Promise<void> {
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
  const proxy = new GatewayProxy(config, logger, models, thinking, bridge, new UsageTracker("./data/usage-test.json"));

  const app = express();
  app.use("/v1", express.json({ limit: "100mb" }));
  app.use("/v1", proxy.createMiddleware());
  const gateway = http.createServer(app);
  await new Promise<void>((r) => gateway.listen(0, r));
  const gwPort = (gateway.address() as { port: number }).port;

  pending = (_req, res) => {
    const body = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude",
      content: [
        {
          type: "text",
          text: "<think>secret reasoning here</think>\n\nThe real answer.",
        },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 2 },
    };
    const s = JSON.stringify(body);
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(s),
    });
    res.end(s);
  };

  const r = await fetch(`http://127.0.0.1:${gwPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/gpt-5",
      messages: [],
      max_tokens: 100,
    }),
  });
  const j = (await r.json()) as {
    content: Array<{ type: string; text?: string; thinking?: string }>;
  };
  console.log("STATUS", r.status);
  console.log("CONTENT BLOCKS:", JSON.stringify(j.content, null, 2));
  const leaked = JSON.stringify(j.content).includes("<think>");
  const hasThinkingBlock = j.content.some((b) => b.type === "thinking");
  console.log("LEAKED <think>?", leaked);
  console.log("Has thinking content block?", hasThinkingBlock);

  await Promise.all([
    new Promise<void>((rr) => gateway.close(() => rr())),
    new Promise<void>((rr) => upstream.close(() => rr())),
  ]);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
