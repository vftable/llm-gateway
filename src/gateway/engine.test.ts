// Failover-hardening tests: forward() must always resolve (never reject) and
// must fall over / finish cleanly instead of letting an exception escape to a
// 500. We drive a real engine against an in-memory DB, using an unserializable
// request body (a BigInt) to force the request-serialization path to throw —
// which exercises the guarded attempt path deterministically with no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, closeDatabase } from "../db";
import { createProvider } from "../repo/providers";
import { createModel, getModel } from "../repo/models";
import { Logger } from "../logger";
import { ThinkingConverter } from "../formats/thinking";
import { ForwardingEngine, type ForwardContext } from "./engine";
import type { Model } from "../types";

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

// Minimal Express-ish response capturing status + json. Enough for the
// failover/finish502 path (which never streams here).
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
    writeHead() {
      state.headersSent = true;
      return res;
    },
    end() {
      state.writableEnded = true;
    },
    write() {
      return true;
    },
  };
  return { res, state };
}

function seededModel(db: ReturnType<typeof openDatabase>): Model {
  createProvider(db, {
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

function ctxFor(model: Model, body: Record<string, unknown>): ForwardContext {
  return {
    clientPath: "/v1/chat/completions",
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

test("forward() resolves with 502 when the model has no usable provider chain", async () => {
  const db = openDatabase(":memory:");
  try {
    // A model with a provider link that references a disabled provider -> empty
    // chain -> clean 502, no throw.
    createProvider(db, {
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
