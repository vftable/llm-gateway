// testProviderModel()/makeLogStage() debug-tracing seam — verifies the
// logStage plumbing added so probeEndpoint() prints the same per-stage XFORM
// trace a real request gets: gated on settings.debugLogging, undefined (no
// tracing, zero cost) when db/logger are omitted or the setting is off, wired
// through to the adapter's TestModelCtx only when it's on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../db";
import { saveSettings } from "../../repo/settings";
import { createProvider } from "../../repo/providers";
import { testProviderModel, makeLogStage } from "./provider-probe";
import { Logger } from "../../logger";
import { WireKind } from "../../types";

function freshDb() {
  return openDatabase(":memory:");
}

// catalogId left unset + endpoints pinned to Messages, so `adapterForProvider`
// falls back to GENERIC_ANTHROPIC (anthropic-compatible) — whose class
// declares no testModel() override, unlike GENERIC_OPENAI's
// OpenAICompatibleAdapter (which has a REAL probeEndpoint()-based testModel()
// — see test-model.test.ts). This keeps these tests on the true dummy-stub
// default, network-free; the point here is the logStage GATING, not any
// specific adapter's probe body.
function seedProvider(db: ReturnType<typeof freshDb>) {
  return createProvider(db, {
    name: "Test Provider",
    baseUrl: "https://api.example.com",
    apiKeys: ["sk-test"],
    format: "anthropic",
    endpoints: [WireKind.Messages],
    authScheme: "bearer",
  });
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

test("makeLogStage: returns a callback that logs via Logger.transform when debugLogging is on", () => {
  const db = freshDb();
  saveSettings(db, { debugLogging: true });
  const logger = new Logger();
  const lines: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    lines.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const logStage = makeLogStage(db, logger, "my-provider");
    assert.ok(logStage);
    logStage!("req", "family:anthropic-cache", true);
  } finally {
    process.stdout.write = origWrite;
  }
  const joined = lines.join("");
  assert.ok(joined.includes("XFORM"));
  assert.ok(joined.includes("family:anthropic-cache"));
  assert.ok(joined.includes("my-provider"));
  assert.ok(joined.includes("changed=true"));
});

test("testProviderModel: no db/logger given -> no tracing, dummy stub still resolves", async () => {
  const db = freshDb();
  const p = seedProvider(db);
  const result = await testProviderModel(p, "some-upstream-id");
  assert.equal(result.ok, true);
  assert.equal((result.data as { dummy: boolean }).dummy, true);
});

test("testProviderModel: db/logger given but debugLogging off -> no console tracing", async () => {
  const db = freshDb();
  const p = seedProvider(db);
  const logger = new Logger();
  const lines: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    lines.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await testProviderModel(p, "some-upstream-id", db, logger);
  } finally {
    process.stdout.write = origWrite;
  }
  assert.equal(
    lines.some((l) => l.includes("XFORM")),
    false,
  );
});
