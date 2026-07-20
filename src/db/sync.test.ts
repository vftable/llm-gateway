// config.json -> DB sync: the seeded config-upstream provider adopts the "proxy"
// provider type (accepts all three wire kinds, converts internally).

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, closeDatabase } from ".";
import { syncFromConfig } from "./sync";
import { getProvider } from "../repo/providers";
import type { ConfigJson } from "../config";

function cfg(over: Partial<ConfigJson> = {}): ConfigJson {
  return {
    upstream: "https://bridge.example.com/",
    upstreamApiKey: "sk-up",
    ...over,
  } as ConfigJson;
}

test("config-synced upstream is seeded as the proxy provider type", () => {
  const db = openDatabase(":memory:");
  try {
    const res = syncFromConfig(db, cfg());
    const p = getProvider(db, res.providerId!)!;
    assert.equal(p.id, "config-upstream");
    // Proxy type: converts internally + accepts all three wire kinds.
    assert.equal(p.catalogId, "proxy");
    assert.equal(p.nativeConversion, true);
    assert.equal(p.authScheme, "both");
    assert.deepEqual([...p.endpoints].sort(), [
      "chat",
      "messages",
      "responses",
    ]);
    // Config values still applied over the template.
    assert.equal(p.baseUrl, "https://bridge.example.com"); // trailing slash trimmed
    assert.equal(p.keyCount.total, 1);
    assert.equal(p.keyCount.enabled, 1);
  } finally {
    closeDatabase(db);
  }
});

test("re-sync updates the existing provider in place (no duplicate)", () => {
  const db = openDatabase(":memory:");
  try {
    const a = syncFromConfig(db, cfg());
    const b = syncFromConfig(
      db,
      cfg({ upstream: "https://bridge2.example.com" }),
    );
    assert.equal(a.providerId, b.providerId);
    const p = getProvider(db, b.providerId!)!;
    assert.equal(p.baseUrl, "https://bridge2.example.com");
    // Still the proxy type after update.
    assert.equal(p.nativeConversion, true);
  } finally {
    closeDatabase(db);
  }
});
