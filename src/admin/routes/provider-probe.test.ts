// testProviderModel()/makeLogStage() debug-tracing seam — verifies the
// logStage plumbing added so probeEndpoint() prints the same per-stage XFORM
// trace a real request gets: gated on settings.debugLogging, undefined (no
// tracing, zero cost) when db/logger are omitted or the setting is off, wired
// through to the adapter's TestModelCtx only when it's on.
//
// Also covers rawRequest's redirect-following (via makeUsageCtx's `request`,
// the same transport keyUsage()/testModel() use) against a real local HTTP
// server, so a 301/302/307/308 from a reverse proxy or an http->https
// canonicalization resolves transparently instead of surfacing as a bare
// "status 301" failure.
//
// IMPORTANT: none of these tests monkey-patch process.stdout.write. node:test's
// own reporter defers writing completed tests' TAP output to stdout, and if a
// test patches process.stdout.write — even briefly, even correctly restored in
// a finally block — any of the reporter's pending writes for EARLIER,
// already-finished tests that happen to fire while the patch is active get
// silently swallowed instead of reaching the terminal (repro'd: those tests
// vanish from the run summary entirely — not fail, just never reported, and
// the process still exits 0). Spy on Logger.prototype.transform instead,
// which is call-count/argument observable without touching the global stream.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { openDatabase } from "../../db";
import { saveSettings } from "../../repo/settings";
import { createProvider } from "../../repo/providers";
import {
  testProviderModel,
  makeLogStage,
  makeUsageCtx,
} from "./provider-probe";
import { Logger } from "../../logger";
import { WireKind } from "../../types";

function freshDb() {
  return openDatabase(":memory:");
}

// Start a bare local HTTP server for one test; returns the origin + a
// disposer. Each test defines its own request handler. Used instead of a
// real network probe (e.g. a fake domain or an unused port) so every probe
// settles fast and deterministically on real HTTP semantics.
function withServer(
  handler: http.RequestListener,
): Promise<{ origin: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// Spy on Logger.prototype.transform for the duration of `fn`, returning the
// calls observed. Restores the original method even if `fn` throws. Safe to
// use across an await boundary (unlike patching process.stdout.write — see
// the file-level doc comment above).
async function spyOnTransform(
  fn: () => Promise<void>,
): Promise<Array<{ dir: string; name: string }>> {
  const calls: Array<{ dir: string; name: string }> = [];
  const orig = Logger.prototype.transform;
  Logger.prototype.transform = function (dir: string, name: string) {
    calls.push({ dir, name });
  };
  try {
    await fn();
  } finally {
    Logger.prototype.transform = orig;
  }
  return calls;
}

test("makeLogStage: undefined when db is omitted", () => {
  const logger = new Logger();
  assert.equal(makeLogStage(undefined, logger, "p"), undefined);
});

test("makeLogStage: undefined when logger is omitted", () => {
  const db = freshDb();
  assert.equal(makeLogStage(db, undefined, "p"), undefined);
});

test("makeLogStage: undefined when settings.debugLogging is off (the default)", () => {
  const db = freshDb();
  const logger = new Logger();
  assert.equal(makeLogStage(db, logger, "p"), undefined);
});

test("makeLogStage: returns a callback that logs via Logger.transform when debugLogging is on", async () => {
  const db = freshDb();
  saveSettings(db, { debugLogging: true });
  const logger = new Logger();
  const calls = await spyOnTransform(async () => {
    const logStage = makeLogStage(db, logger, "my-provider");
    assert.ok(logStage);
    logStage!("req", "family:anthropic-cache", true);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dir, "req");
  assert.equal(calls[0].name, "family:anthropic-cache");
});

test("testProviderModel: db/logger given but debugLogging off -> no console tracing", async () => {
  const db = freshDb();
  // A real (if unhelpful) local listener — a genuine unreachable-address
  // probe risks an uncaught DNS/connection-refused exception escaping the
  // adapter in a way this test doesn't want to depend on. 500 makes
  // probeEndpoint() report a clean failure with no upstream body to parse.
  const { origin, close } = await withServer((_req, res) => {
    res.writeHead(500);
    res.end();
  });
  try {
    // Use an OpenAI-format provider so adapterForProvider falls back to
    // GENERIC_OPENAI, which also has a real testModel() that calls
    // probeEndpoint(). The probe fails (500), but we only care that no
    // XFORM trace lines appear when debugLogging is off.
    const p = createProvider(db, {
      name: "Test Provider",
      baseUrl: origin,
      apiKeys: ["sk-test"],
      format: "openai",
      endpoints: [WireKind.Chat],
      authScheme: "bearer",
    });
    const logger = new Logger();
    const calls = await spyOnTransform(async () => {
      await testProviderModel(p, "some-upstream-id", db, logger);
    });
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

// --- rawRequest redirect-following (via makeUsageCtx's real transport) -----

function providerFor(baseUrl: string) {
  return createProvider(freshDb(), {
    name: "Redirect Test Provider",
    baseUrl,
    apiKeys: ["sk-test"],
    format: "openai",
    endpoints: [WireKind.Chat],
    authScheme: "bearer",
  });
}

test("rawRequest (via makeUsageCtx.request): follows a single 301 to a JSON body", async () => {
  const { origin, close } = await withServer((req, res) => {
    if (req.url === "/old-path") {
      res.writeHead(301, { location: "/new-path" });
      res.end();
      return;
    }
    if (req.url === "/new-path") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const p = providerFor(origin);
    const ctx = makeUsageCtx(p);
    const result = await ctx.request(ctx.resolve("/old-path"), {
      method: "GET",
      headers: {},
    });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.text), { ok: true });
  } finally {
    await close();
  }
});

test("rawRequest: 307 preserves method + body across the redirect", async () => {
  const seen: Array<{ method?: string; body: string }> = [];
  const { origin, close } = await withServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method, body });
      if (req.url === "/step1") {
        res.writeHead(307, { location: "/step2" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ received: body }));
    });
  });
  try {
    const p = providerFor(origin);
    const ctx = makeUsageCtx(p);
    const result = await ctx.request(ctx.resolve("/step1"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { hello: "world" },
    });
    assert.equal(result.status, 200);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[1].method, "POST");
    assert.equal(seen[1].body, seen[0].body);
  } finally {
    await close();
  }
});

test("rawRequest: 302 downgrades a POST to GET (drops the body), matching real clients", async () => {
  const seen: string[] = [];
  const { origin, close } = await withServer((req, res) => {
    seen.push(req.method ?? "");
    if (req.url === "/post-here") {
      res.writeHead(302, { location: "/after" });
      res.end();
      return;
    }
    res.writeHead(200);
    res.end("done");
  });
  try {
    const p = providerFor(origin);
    const ctx = makeUsageCtx(p);
    await ctx.request(ctx.resolve("/post-here"), {
      method: "POST",
      headers: {},
      body: { a: 1 },
    });
    assert.deepEqual(seen, ["POST", "GET"]);
  } finally {
    await close();
  }
});

test("rawRequest: a redirect loop stops at MAX_REDIRECTS and returns the last redirect response", async () => {
  let hops = 0;
  const { origin, close } = await withServer((req, res) => {
    hops++;
    res.writeHead(301, { location: "/loop" });
    res.end();
  });
  try {
    const p = providerFor(origin);
    const ctx = makeUsageCtx(p);
    const result = await ctx.request(ctx.resolve("/loop"), {
      method: "GET",
      headers: {},
    });
    // Never hangs, never throws — settles on a 301 after a bounded hop count.
    assert.equal(result.status, 301);
    assert.ok(hops <= 6, `expected a bounded hop count, got ${hops}`);
  } finally {
    await close();
  }
});

test("rawRequest: a redirect with no Location header returns the redirect response itself", async () => {
  const { origin, close } = await withServer((_req, res) => {
    res.writeHead(301);
    res.end();
  });
  try {
    const p = providerFor(origin);
    const ctx = makeUsageCtx(p);
    const result = await ctx.request(ctx.resolve("/no-location"), {
      method: "GET",
      headers: {},
    });
    assert.equal(result.status, 301);
  } finally {
    await close();
  }
});
