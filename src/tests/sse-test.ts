// End-to-end SSE streaming test through the real GatewayProxy:
// - Mock upstream sends 4 SSE events with 150ms gaps between them
// - Client measures inter-chunk arrival times
// - If gaps are preserved (~150ms apart), streaming is NOT buffered
// - If all chunks arrive at once (~0ms apart), something is buffering
//
// Also tests ping keep-alive: a slow upstream (15s+ without data) should
// generate SSE comment pings to keep the Cloudflare tunnel alive.

import http from "http";
import express from "express";
import { loadConfig } from "../config";
import { Logger } from "../logger";
import { ModelRegistry } from "../models";
import { ThinkingConverter } from "../thinking";
import { ResponsesBridge } from "../responses-bridge";
import { GatewayProxy } from "../proxy";

const UPSTREAM_EVENTS = [
  "data: chunk-1\n\n",
  "data: chunk-2\n\n",
  "data: chunk-3\n\n",
  "data: [DONE]\n\n",
];
const INTER_EVENT_MS = 150;

const upstream = http.createServer((_req, res) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let i = 0;
  const tick = () => {
    if (i >= UPSTREAM_EVENTS.length) {
      res.end();
      return;
    }
    res.write(UPSTREAM_EVENTS[i]);
    i++;
    setTimeout(tick, INTER_EVENT_MS);
  };
  // Small delay before first chunk to simulate time-to-first-token.
  setTimeout(tick, 50);
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

  console.log("=== SSE streaming test ===");
  const t0 = process.hrtime.bigint();
  const resp = await fetch(`http://127.0.0.1:${gwPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic/gpt-5",
      stream: true,
      messages: [],
    }),
  });
  console.log(
    "status:",
    resp.status,
    "content-type:",
    resp.headers.get("content-type"),
  );

  const arrivalTimes: Array<{ t: string; bytes: number; text: string }> = [];
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let aggregated = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const t = Number(process.hrtime.bigint() - t0) / 1e6;
    const text = decoder.decode(value, { stream: true });
    aggregated += text;
    arrivalTimes.push({
      t: t.toFixed(0),
      bytes: value.length,
      text: JSON.stringify(text),
    });
  }
  const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log("total time (ms):", totalMs.toFixed(0));
  console.log("chunks received:", arrivalTimes.length);
  console.log("arrival schedule:");
  for (const a of arrivalTimes) {
    console.log("  +" + a.t.padStart(4) + "ms  " + a.bytes + "b  " + a.text);
  }

  const gaps: number[] = [];
  for (let i = 1; i < arrivalTimes.length; i++) {
    gaps.push(Number(arrivalTimes[i].t) - Number(arrivalTimes[i - 1].t));
  }
  console.log("inter-chunk gaps (ms):", gaps.join(", "));
  const allArrivedAtOnce = gaps.length > 0 && gaps.every((g) => g < 30);
  console.log(
    allArrivedAtOnce
      ? "BUFFERING DETECTED — all chunks arrived at once, SSE is broken"
      : "STREAMING OK — chunks arrived with time gaps preserved",
  );

  await Promise.all([
    new Promise<void>((r) => gateway.close(() => r())),
    new Promise<void>((r) => upstream.close(() => r())),
  ]);

  if (allArrivedAtOnce) {
    process.exitCode = 1;
    return;
  }

  // === Test 2: Ping keep-alive during long idle periods ===
  console.log("\n=== SSE ping keep-alive test ===");

  // Upstream that sends one chunk then goes silent for 1 second
  const slowUpstream = http.createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    // Send first chunk immediately, then go silent
    res.write("data: initial\n\n");
    // Keep connection open for 1 second without sending anything
    setTimeout(() => {
      res.write("data: final\n\n");
      res.end();
    }, 1500);
  });

  slowUpstream.listen(0, async () => {
    const config2 = loadConfig();
    config2.upstream = `http://127.0.0.1:${(slowUpstream.address() as { port: number }).port}`;
    config2.ssePingInterval = 500; // 500ms for fast testing

    const logger2 = new Logger();
    const models2 = new ModelRegistry(config2.models);
    const thinking2 = new ThinkingConverter();
    const bridge2 = new ResponsesBridge();
    const proxy2 = new GatewayProxy(
      config2,
      logger2,
      models2,
      thinking2,
      bridge2,
    );

    const app2 = express();
    app2.use("/v1", express.json({ limit: "100mb" }));
    app2.use("/v1", proxy2.createMiddleware());

    const gateway2 = http.createServer(app2);
    await new Promise<void>((r) => gateway2.listen(0, r));
    const gwPort2 = (gateway2.address() as { port: number }).port;

    const t0 = process.hrtime.bigint();
    const resp = await fetch(`http://127.0.0.1:${gwPort2}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/gpt-5",
        stream: true,
        messages: [],
      }),
    });

    const chunks: Array<{ t: number; text: string }> = [];
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let gotInitial = false;
    let gotPing = false;
    let gotFinal = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const t = Number(process.hrtime.bigint() - t0) / 1e6;
        const text = decoder.decode(value, { stream: true });
        chunks.push({ t, text });

        if (text.includes("data: initial")) gotInitial = true;
        if (text.includes(": ping")) gotPing = true;
        if (text.includes("data: final")) gotFinal = true;

        // Don't wait forever
        if (t > 3000) break;
      }
    } catch (_e) {
      // Stream may be aborted
    }

    const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log("total time (ms):", totalMs.toFixed(0));
    console.log("chunks received:", chunks.length);
    console.log("got initial:", gotInitial);
    console.log("got ping:", gotPing);
    console.log("got final:", gotFinal);

    const pingOk = gotInitial && gotPing && gotFinal;
    console.log(
      pingOk
        ? "PING OK — keep-alive pings sent during idle period"
        : "PING FAIL — missing expected events",
    );

    await Promise.all([
      new Promise<void>((r) => gateway2.close(() => r())),
      new Promise<void>((r) => slowUpstream.close(() => r())),
    ]);

    if (!pingOk) process.exitCode = 1;
  });
});
