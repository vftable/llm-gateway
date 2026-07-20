import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANTHROPIC_PING_EVENT,
  ANTHROPIC_PING_INTERVAL_MS,
  SsePingKeepAlive,
} from "./sse-ping";

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

test("Anthropic ping constants use the required wire frame and 15-second cadence", () => {
  assert.equal(ANTHROPIC_PING_INTERVAL_MS, 15_000);
  assert.equal(ANTHROPIC_PING_EVENT, 'event: ping\ndata: {"type":"ping"}\n\n');
});

test("strict-cadence ping emits a named event even while content is flowing", async () => {
  const ping = new SsePingKeepAlive({
    interval: 15,
    pingMessage: ANTHROPIC_PING_EVENT,
    idleOnly: false,
  });
  let output = "";
  ping.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });

  const traffic = setInterval(() => ping.write("data: content\n\n"), 4);
  await wait(40);
  clearInterval(traffic);
  ping.end();

  assert.ok(output.includes(ANTHROPIC_PING_EVENT));
  assert.ok(output.includes("data: content\n\n"));
  assert.equal(output.includes(": ping\n\n"), false);
});

test("generic keepalive remains idle-only", async () => {
  const ping = new SsePingKeepAlive({ interval: 20 });
  let output = "";
  ping.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });

  const traffic = setInterval(() => ping.write("data: content\n\n"), 5);
  await wait(45);
  clearInterval(traffic);
  ping.end();

  assert.equal(output.includes(": ping\n\n"), false);
});
