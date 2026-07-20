// Failover-hardening tests: forward() must always resolve (never reject) and
// must fall over / finish cleanly instead of letting an exception escape to a
// 500. We drive a real engine against an in-memory DB, using an unserializable
// request body (a BigInt) to force the request-serialization path to throw —
// which exercises the guarded attempt path deterministically with no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import { Writable } from "stream";
import type { AddressInfo } from "net";
import { openDatabase, closeDatabase } from "../db";
import { createProvider } from "../repo/providers";
import { createModel, getModel } from "../repo/models";
import { Logger } from "../logger";
import { ThinkingConverter } from "../formats/thinking";
import { ForwardingEngine, type ForwardContext } from "./engine";
import type { Model } from "../types";
import { WireKind } from "../types";

// A quiet logger (suppress console noise during the test run).
function quietLogger(): Logger {
  const l = new Logger();
  const noop = () => {};
  // Silence the write paths; we only assert on behavior, not log output.
  (l as unknown as { write: () => void }).write = noop;
  (l as unknown as { request: () => void }).request = noop;
  (l as unknown as { transform: () => void }).transform = noop;
  return l;
}

// Minimal Express-ish response capturing status + json. Covers both the
// failover/finish502 path (res.status().json()) and the normal buffered
// forward path (res.writeHead(status, headers) + res.end(buf)) — the latter
// is what a successful (possibly cross-format-converted) response goes
// through, so `end()` captures + JSON-parses whatever bytes it's given into
// state.body for assertions.
function mockRes() {
  const state = {
    statusCode: 0 as number,
    body: null as unknown,
    headersSent: false,
    writableEnded: false,
  };
  const res = {
    get headersSent() {
      return state.headersSent;
    },
    get writableEnded() {
      return state.writableEnded;
    },
    status(code: number) {
      state.statusCode = code;
      return {
        json(b: unknown) {
          state.body = b;
          state.headersSent = true;
          state.writableEnded = true;
        },
      };
    },
    // Present in case a path reaches them; unused in the BigInt path.
    on() {
      return res;
    },
    once() {
      return res;
    },
    off() {
      return res;
    },
    writeHead(code: number) {
      state.statusCode = code;
      state.headersSent = true;
      return res;
    },
    end(chunk?: Buffer | string) {
      state.writableEnded = true;
      if (chunk === undefined) return;
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      try {
        state.body = JSON.parse(text);
      } catch {
        state.body = text;
      }
    },
    write() {
      return true;
    },
  };
  return { res, state };
}

function seededModel(db: ReturnType<typeof openDatabase>): Model {
  createProvider(db, {
    id: "p",
    name: "p",
    baseUrl: "http://127.0.0.1:9",
    apiKeys: ["k1"],
    // one attempt so the test finishes fast and deterministically
    retryAttempts: 1,
  });
  const m = createModel(db, {
    alias: "test-model",
    providers: [{ providerId: "p", upstreamModel: "up-1" }],
  });
  return getModel(db, m.id)!;
}

function ctxFor(
  model: Model,
  body: Record<string, unknown>,
  clientPath = "/v1/chat/completions",
): ForwardContext {
  return {
    clientPath,
    requestBody: body,
    resolvedModel: model,
    alias: model.alias,
    apiKey: null,
    inputTokens: 0,
    reservedTokens: 0,
    isStream: false,
    client: null,
    debug: false,
  };
}

test("forward() resolves with 502 when request serialization throws (no escape)", async () => {
  const db = openDatabase(":memory:");
  try {
    const model = seededModel(db);
    const engine = new ForwardingEngine(
      db,
      quietLogger(),
      new ThinkingConverter(),
      0,
    );
    const { res, state } = mockRes();
    // A BigInt makes JSON.stringify throw inside attemptOnce's guarded block.
    const body: Record<string, unknown> = {
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      // eslint-disable-next-line no-undef
      bad: BigInt(1),
    };

    // The contract: this promise resolves (never rejects), and the client gets
    // a clean 502 rather than an unhandled exception bubbling to a 500.
    await assert.doesNotReject(async () => {
      await engine.forward(
        { method: "POST", headers: {} } as never,
        res as never,
        ctxFor(model, body),
      );
    });
    assert.equal(state.statusCode, 502);
  } finally {
    closeDatabase(db);
  }
});

test("forward() sends the adapter-built request to the wire (verbatim default)", async () => {
  // A real local upstream captures what the engine actually sent: path, auth
  // header, and the body with the upstream model id stamped by the builder path.
  const captured: {
    path?: string;
    auth?: string;
    body?: Record<string, unknown>;
  } = {};
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      captured.path = req.url;
      captured.auth = req.headers["authorization"] as string;
      try {
        captured.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        captured.body = undefined;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "x",
          usage: { prompt_tokens: 3, completion_tokens: 5 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const db = openDatabase(":memory:");
  try {
    createProvider(db, {
      id: "up",
      name: "up",
      baseUrl: `http://127.0.0.1:${port}`,
      apiKeys: ["k-secret"],
      catalogId: "openai",
      authScheme: "bearer",
      retryAttempts: 1,
    });
    const m = createModel(db, {
      alias: "test-model",
      providers: [{ providerId: "up", upstreamModel: "up-1" }],
    });
    const model = getModel(db, m.id)!;
    const engine = new ForwardingEngine(
      db,
      quietLogger(),
      new ThinkingConverter(),
      0,
    );
    const { res, state } = mockRes();
    await engine.forward(
      { method: "POST", headers: {} } as never,
      res as never,
      ctxFor(model, {
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    assert.equal(state.statusCode || 200, 200);
    assert.ok(captured.path?.endsWith("/v1/chat/completions"));
    assert.equal(captured.auth, "Bearer k-secret");
    // The builder path stamps the upstream model id onto the body it sends.
    assert.equal(captured.body?.model, "up-1");
  } finally {
    closeDatabase(db);
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("forward() merges client headers first, then the gateway's own values win on collision", async () => {
  // The header-merge contract (TransformCtx.headers / engine.ts buildHeaders):
  // client headers form the base, then the gateway's own values (auth from
  // the selected key, host) are layered on top and WIN — a client sending its
  // own bogus `authorization` must never reach the upstream; a harmless
  // client-only header must still pass through untouched.
  const captured: { headers?: http.IncomingHttpHeaders } = {};
  const server = http.createServer((req, res) => {
    captured.headers = req.headers;
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "x",
          usage: { prompt_tokens: 3, completion_tokens: 5 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const db = openDatabase(":memory:");
  try {
    createProvider(db, {
      id: "up",
      name: "up",
      baseUrl: `http://127.0.0.1:${port}`,
      apiKeys: ["k-secret"],
      catalogId: "openai",
      authScheme: "bearer",
      retryAttempts: 1,
    });
    const m = createModel(db, {
      alias: "test-model",
      providers: [{ providerId: "up", upstreamModel: "up-1" }],
    });
    const model = getModel(db, m.id)!;
    const engine = new ForwardingEngine(
      db,
      quietLogger(),
      new ThinkingConverter(),
      0,
    );
    const { res, state } = mockRes();
    await engine.forward(
      {
        method: "POST",
        headers: {
          // A harmless client header — should pass through untouched.
          "x-client-trace": "abc123",
          // A client trying to smuggle its OWN auth — the gateway's key must
          // win instead (buildHeaders drops client authorization entirely).
          authorization: "Bearer client-supplied-and-must-be-dropped",
        },
      } as never,
      res as never,
      ctxFor(model, {
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    assert.equal(state.statusCode || 200, 200);
    assert.equal(captured.headers?.["x-client-trace"], "abc123");
    assert.equal(captured.headers?.["authorization"], "Bearer k-secret");
  } finally {
    closeDatabase(db);
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("forward() with authScheme 'passthrough' forwards the client's own auth header upstream", async () => {
  // Passthrough means "the gateway holds no auth of its own for this
  // provider — send the client's own credentials through untouched." Before
  // this fix, buildHeaders unconditionally stripped authorization/x-api-key
  // from the client-passthrough loop, and applyAuthHeaders is correctly a
  // no-op for "passthrough" — so the client's auth was silently dropped and
  // the upstream got NO auth header at all.
  const captured: { headers?: http.IncomingHttpHeaders } = {};
  const server = http.createServer((req, res) => {
    captured.headers = req.headers;
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "x",
          usage: { prompt_tokens: 3, completion_tokens: 5 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const db = openDatabase(":memory:");
  try {
    createProvider(db, {
      id: "up",
      name: "up",
      baseUrl: `http://127.0.0.1:${port}`,
      // A configured key exists, but authScheme "passthrough" means it's
      // never applied — client auth must be forwarded instead.
      apiKeys: ["k-unused-in-passthrough"],
      catalogId: "openai",
      authScheme: "passthrough",
      retryAttempts: 1,
    });
    const m = createModel(db, {
      alias: "test-model",
      providers: [{ providerId: "up", upstreamModel: "up-1" }],
    });
    const model = getModel(db, m.id)!;
    const engine = new ForwardingEngine(
      db,
      quietLogger(),
      new ThinkingConverter(),
      0,
    );
    const { res, state } = mockRes();
    await engine.forward(
      {
        method: "POST",
        headers: { authorization: "Bearer client-own-token" },
      } as never,
      res as never,
      ctxFor(model, {
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    assert.equal(state.statusCode || 200, 200);
    assert.equal(
      captured.headers?.["authorization"],
      "Bearer client-own-token",
    );
  } finally {
    closeDatabase(db);
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("forward() with no provider key configured forwards the client's own auth header upstream", async () => {
  // A keyless provider (e.g. a local server) still routes (key-health.ts:
  // "a keyless provider still routes — the engine sends no auth" is about
  // the GATEWAY's own auth; the client's own credentials, if any, are the
  // only auth available and must reach the upstream, not be dropped.
  const captured: { headers?: http.IncomingHttpHeaders } = {};
  const server = http.createServer((req, res) => {
    captured.headers = req.headers;
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "x",
          usage: { prompt_tokens: 3, completion_tokens: 5 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const db = openDatabase(":memory:");
  try {
    createProvider(db, {
      id: "up",
      name: "up",
      baseUrl: `http://127.0.0.1:${port}`,
      apiKeys: [], // no key at all
      catalogId: "openai",
      authScheme: "bearer",
      retryAttempts: 1,
    });
    const m = createModel(db, {
      alias: "test-model",
      providers: [{ providerId: "up", upstreamModel: "up-1" }],
    });
    const model = getModel(db, m.id)!;
    const engine = new ForwardingEngine(
      db,
      quietLogger(),
      new ThinkingConverter(),
      0,
    );
    const { res, state } = mockRes();
    await engine.forward(
      {
        method: "POST",
        headers: { authorization: "Bearer client-own-token" },
      } as never,
      res as never,
      ctxFor(model, {
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    assert.equal(state.statusCode || 200, 200);
    assert.equal(
      captured.headers?.["authorization"],
      "Bearer client-own-token",
    );
  } finally {
    closeDatabase(db);
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("forward() resolves with 502 when the model has no usable provider chain", async () => {
  const db = openDatabase(":memory:");
  try {
    // A model with a provider link that references a disabled provider -> empty
    // chain -> clean 502, no throw.
    createProvider(db, {
      id: "off",
      name: "off",
      baseUrl: "http://127.0.0.1:9",
      apiKeys: ["k"],
      enabled: false,
    });
    const m = createModel(db, {
      alias: "orphan",
      providers: [{ providerId: "off", upstreamModel: "x" }],
    });
    const model = getModel(db, m.id)!;
    const engine = new ForwardingEngine(
      db,
      quietLogger(),
      new ThinkingConverter(),
      0,
    );
    const { res, state } = mockRes();
    await assert.doesNotReject(async () => {
      await engine.forward(
        { method: "POST", headers: {} } as never,
        res as never,
        ctxFor(model, {
          model: "orphan",
          messages: [{ role: "user", content: "hi" }],
        }),
      );
    });
    assert.equal(state.statusCode, 502);
  } finally {
    closeDatabase(db);
  }
});

// A Writable that captures everything written, usable as the streaming `res`
// (streamPipeline pipes the SSE bytes into it). Tracks headers + collected text.
function streamRes() {
  const state = {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    text: "",
  };
  const w = new Writable({
    write(chunk, _enc, cb) {
      state.text += chunk.toString("utf8");
      cb();
    },
  }) as Writable & {
    headersSent: boolean;
    writeHead: (c: number, h?: Record<string, unknown>) => unknown;
    status: (c: number) => { json: (b: unknown) => void };
  };
  w.headersSent = false;
  w.writeHead = (code: number, h?: Record<string, unknown>) => {
    state.statusCode = code;
    state.headers = h ?? {};
    w.headersSent = true;
    return w;
  };
  w.status = (code: number) => ({
    json: () => {
      state.statusCode = code;
      w.headersSent = true;
    },
  });
  return { res: w, state };
}

test("streaming: primes a ping on connect + surfaces upstream error as SSE event", async () => {
  // Upstream sends an event-stream, one chunk, then destroys the socket WITHOUT
  // a terminating [DONE] — an abnormal end the gateway must surface, not swallow.
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    setTimeout(() => res.destroy(), 20); // abnormal mid-stream termination
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const db = openDatabase(":memory:");
  try {
    createProvider(db, {
      id: "up",
      name: "up",
      baseUrl: `http://127.0.0.1:${port}`,
      apiKeys: ["k"],
      catalogId: "openai",
      retryAttempts: 1,
    });
    const m = createModel(db, {
      alias: "test-model",
      providers: [{ providerId: "up", upstreamModel: "up-1" }],
    });
    const model = getModel(db, m.id)!;
    // Messages streams always prime a protocol-native ping immediately.
    const engine = new ForwardingEngine(
      db,
      quietLogger(),
      new ThinkingConverter(),
      15000,
    );
    const { res, state } = streamRes();
    await engine.forward(
      { method: "POST", headers: {} } as never,
      res as never,
      {
        ...ctxFor(
          model,
          {
            model: "test-model",
            messages: [{ role: "user", content: "hi" }],
          },
          "/v1/messages",
        ),
        isStream: true,
      },
    );
    // Streaming settles asynchronously (forward() returns once the upstream 2xx
    // is committed; the pipeline error/settle fires after). Wait for the stream
    // to finish before asserting on the collected bytes.
    await new Promise<void>((r) => {
      const started = Date.now();
      const iv = setInterval(() => {
        if (
          state.text.includes("event: error") ||
          Date.now() - started > 2000
        ) {
          clearInterval(iv);
          r();
        }
      }, 10);
    });
    // Primed ping landed at connect, the one content chunk streamed, and the
    // abnormal upstream end surfaced as a terminal SSE error event (not a hang).
    assert.ok(
      state.text.startsWith('event: ping\ndata: {"type":"ping"}\n\n'),
      "expected a primed Anthropic ping event first",
    );
    assert.ok(
      state.text.includes('"text":"hi"'),
      "expected the converted Anthropic text delta",
    );
    assert.ok(
      state.text.includes("event: error"),
      "expected a terminal error event",
    );
  } finally {
    closeDatabase(db);
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("pipeThrough SSE: a native event-stream that dies surfaces a terminal error", async () => {
  // isStream=false but the upstream returns an event-stream and NO conversion is
  // needed (chat client -> chat provider) -> the passthrough path. It must still
  // prime a ping and surface an abnormal end as event: error (parity with
  // streamConvert), not a silent truncation.
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    setTimeout(() => res.destroy(), 20);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const db = openDatabase(":memory:");
  try {
    createProvider(db, {
      id: "up",
      name: "up",
      baseUrl: `http://127.0.0.1:${port}`,
      apiKeys: ["k"],
      catalogId: "openai",
      retryAttempts: 1,
    });
    const m = createModel(db, {
      alias: "test-model",
      providers: [{ providerId: "up", upstreamModel: "up-1" }],
    });
    const model = getModel(db, m.id)!;
    const engine = new ForwardingEngine(
      db,
      quietLogger(),
      new ThinkingConverter(),
      15000,
    );
    const { res, state } = streamRes();
    // isStream stays false -> handleUpstreamResponse falls through to pipeThrough.
    await engine.forward(
      { method: "POST", headers: {} } as never,
      res as never,
      {
        ...ctxFor(
          model,
          {
            model: "test-model",
            messages: [{ role: "user", content: "hi" }],
          },
          "/v1/messages",
        ),
        isStream: false,
      },
    );
    await new Promise<void>((r) => {
      const started = Date.now();
      const iv = setInterval(() => {
        if (
          state.text.includes("event: error") ||
          Date.now() - started > 2000
        ) {
          clearInterval(iv);
          r();
        }
      }, 10);
    });
    assert.ok(
      state.text.startsWith('event: ping\ndata: {"type":"ping"}\n\n'),
      "expected a primed Anthropic ping event first",
    );
    assert.ok(
      state.text.includes('"content":"hi"'),
      "expected the streamed chunk",
    );
    assert.ok(
      state.text.includes("event: error"),
      "expected a terminal error event",
    );
  } finally {
    closeDatabase(db);
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ===========================================================================
// Cross-format round-trip tests — per the format-route completeness audit,
// engine.test.ts previously only ever exercised chat->chat (no conversion).
// Every cross-format check elsewhere in the suite is a unit test on an
// isolated converter function; these instead drive a REAL request through
// engine.forward() end-to-end (client body -> converted upstream request ->
// upstream response -> converted client response), proving the pipeline
// COMPOSITION + engine plumbing (not just the converter math) works for a
// genuinely mismatched (clientFmt, providerFmt) pair — the exact gap the
// audit flagged as having zero coverage.
// ===========================================================================

// A local http server that always replies with a fixed CHAT-shaped body,
// regardless of what was sent — used as the "chat-native provider" in the
// cross-format tests below (the client format differs from this).
function chatUpstream(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "cc1",
          model: "up-1",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hello from upstream" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 3 },
        }),
      );
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

test("cross-format round-trip: a messages CLIENT against a chat-native PROVIDER converts both ways", async () => {
  const { server, port } = await chatUpstream();
  const db = openDatabase(":memory:");
  try {
    createProvider(db, {
      id: "up",
      name: "up",
      baseUrl: `http://127.0.0.1:${port}`,
      apiKeys: ["k"],
      catalogId: "openai", // openai adapter -> chat-native
      retryAttempts: 1,
    });
    const m = createModel(db, {
      alias: "test-model",
      providers: [{ providerId: "up", upstreamModel: "up-1" }],
    });
    const model = getModel(db, m.id)!;
    const engine = new ForwardingEngine(
      db,
      quietLogger(),
      new ThinkingConverter(),
      0,
    );
    const { res, state } = mockRes();
    // A MESSAGES-shaped client body against a chat-native provider.
    await engine.forward(
      { method: "POST", headers: {} } as never,
      res as never,
      ctxFor(
        model,
        {
          model: "test-model",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        },
        "/v1/messages",
      ),
    );
    assert.equal(state.statusCode, 200);
    // The response the client receives must be MESSAGES-shaped (content
    // blocks, not choices[].message), proving the reverse conversion ran.
    const body = state.body as {
      content?: Array<{ type: string; text?: string }>;
      role?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    assert.equal(body.role, "assistant");
    assert.ok(
      body.content?.some(
        (b) => b.type === "text" && b.text === "hello from upstream",
      ),
      `expected a text content block, got: ${JSON.stringify(body)}`,
    );
    assert.equal(body.usage?.input_tokens, 4);
    assert.equal(body.usage?.output_tokens, 3);
  } finally {
    closeDatabase(db);
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("cross-format round-trip: a chat CLIENT against a responses-native PROVIDER converts both ways (the GPT-5 routing gap this session fixed)", async () => {
  // The upstream here speaks RESPONSES shape (not chat) — proving the engine
  // actually built + sent a Responses-shaped request (via
  // requestFromChatCompletions -> the "chat->responses" REQUEST_CONVERTERS
  // entry) and correctly parsed a Responses-shaped reply back (via
  // responseToChatCompletions -> "responses->chat" RESPONSE_CONVERTERS).
  let capturedBody: Record<string, unknown> | undefined;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      try {
        capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        capturedBody = undefined;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "resp_1",
          object: "response",
          created_at: 100,
          model: "up-1",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "hello from responses" }],
            },
          ],
          usage: { input_tokens: 6, output_tokens: 4 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const db = openDatabase(":memory:");
  try {
    // No catalogId -> generic adapter, routed by declared endpoints: a
    // provider that only accepts WireKind.Responses is responses-native.
    createProvider(db, {
      id: "up",
      name: "up",
      baseUrl: `http://127.0.0.1:${port}`,
      apiKeys: ["k"],
      endpoints: [WireKind.Responses],
      retryAttempts: 1,
    });
    const m = createModel(db, {
      alias: "test-model",
      providers: [{ providerId: "up", upstreamModel: "up-1" }],
    });
    const model = getModel(db, m.id)!;
    const engine = new ForwardingEngine(
      db,
      quietLogger(),
      new ThinkingConverter(),
      0,
    );
    const { res, state } = mockRes();
    // A CHAT-shaped client body against a responses-native provider.
    await engine.forward(
      { method: "POST", headers: {} } as never,
      res as never,
      ctxFor(model, {
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    // Before this session's fix, this hop was `unsupported` and the request
    // would 502 (no provider left to try) — this asserts it now succeeds.
    assert.equal(
      state.statusCode,
      200,
      `expected 200, got ${state.statusCode} body=${JSON.stringify(state.body)}`,
    );
    assert.ok(capturedBody, "expected the upstream to receive a request body");
    // The upstream received Responses shape: `input`, not `messages`.
    assert.ok(
      Array.isArray(capturedBody!.input),
      "expected Responses-shaped `input`",
    );
    assert.equal(capturedBody!.messages, undefined);
    // The client receives CHAT shape back: choices[].message, not `output`.
    const body = state.body as {
      choices?: Array<{ message?: { role?: string; content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    assert.equal(body.choices?.[0]?.message?.role, "assistant");
    assert.equal(body.choices?.[0]?.message?.content, "hello from responses");
    assert.equal(body.usage?.prompt_tokens, 6);
    assert.equal(body.usage?.completion_tokens, 4);
  } finally {
    closeDatabase(db);
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("anthropic:thinking-signature strips a client-echoed thinking block (real OR synthetic signature) before it reaches a native messages upstream", async () => {
  // End-to-end proof for the strip-thinking-signatures request hook: a
  // messages CLIENT continuing a prior turn echoes back an assistant message
  // that carries a `thinking` block with a signature (as Claude Code and the
  // Anthropic SDKs do on a tool-use continuation). The gateway can never
  // prove that signature is valid for whatever provider this hop actually
  // lands on, so it must arrive upstream as plain text, never as a
  // `thinking`-typed block.
  let capturedBody: Record<string, unknown> | undefined;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      try {
        capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        capturedBody = undefined;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "up-1",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const db = openDatabase(":memory:");
  try {
    // catalogId "anthropic" + endpoints:[Messages] -> native messages
    // provider (no format bridge on this hop — the default `openai` catalog
    // adapter's routeFor() falls back to provider.endpoints[0] absent an
    // explicit per-link endpoint, and an "anthropic"-catalog provider with no
    // endpoints declared defaults to ["chat"], which would otherwise route
    // this hop through messagesRequestToChat instead of passing through
    // untouched). Declaring Messages here means the ONLY thing that can
    // strip the thinking block is the request-hook stack, not a
    // chat<->messages converter side effect.
    createProvider(db, {
      id: "up",
      name: "up",
      baseUrl: `http://127.0.0.1:${port}`,
      apiKeys: ["k"],
      catalogId: "anthropic",
      endpoints: [WireKind.Messages],
      retryAttempts: 1,
    });
    const m = createModel(db, {
      alias: "test-model",
      providers: [{ providerId: "up", upstreamModel: "up-1" }],
    });
    const model = getModel(db, m.id)!;
    const engine = new ForwardingEngine(
      db,
      quietLogger(),
      new ThinkingConverter(),
      0,
    );
    const { res, state } = mockRes();
    await engine.forward(
      { method: "POST", headers: {} } as never,
      res as never,
      ctxFor(
        model,
        {
          model: "test-model",
          max_tokens: 100,
          messages: [
            { role: "user", content: "search for x" },
            {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinking: "I should search for x",
                  signature: "a-real-looking-anthropic-signature==",
                },
                { type: "text", text: "searching now" },
              ],
            },
          ],
        },
        "/v1/messages",
      ),
    );
    assert.equal(state.statusCode, 200);
    assert.ok(capturedBody, "expected the upstream to receive a request body");
    const messages = capturedBody!.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    const assistantTurn = messages.find((m) => m.role === "assistant")!;
    assert.ok(
      assistantTurn.content.every((b) => b.type !== "thinking"),
      `expected no thinking-typed block upstream, got: ${JSON.stringify(assistantTurn.content)}`,
    );
    assert.ok(
      assistantTurn.content.some(
        (b) => b.type === "text" && b.text === "I should search for x",
      ),
      "expected the reasoning prose preserved as plain text",
    );
  } finally {
    closeDatabase(db);
    await new Promise<void>((r) => server.close(() => r()));
  }
});
