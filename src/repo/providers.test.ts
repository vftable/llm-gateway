// Providers repo tests against an in-memory SQLite DB. Verifies catalog_id
// round-trips through create/read/update and that the migration path is sane.

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, closeDatabase } from "../db";
import {
  createProvider,
  getProvider,
  updateProvider,
  listProviders,
  normBasePath,
} from "./providers";
import { listProviderKeys } from "./provider-keys";

function freshDb() {
  return openDatabase(":memory:");
}

test("createProvider persists catalogId and defaults", () => {
  const db = freshDb();
  try {
    const p = createProvider(db, {
      name: "NVIDIA NIM",
      baseUrl: "https://integrate.api.nvidia.com/",
      apiKeys: ["nvapi-x"],
      format: "openai",
      authScheme: "bearer",
      catalogId: "nvidia-nim",
    });
    assert.equal(p.catalogId, "nvidia-nim");
    // trailing slash trimmed
    assert.equal(p.baseUrl, "https://integrate.api.nvidia.com");
    const read = getProvider(db, p.id)!;
    assert.equal(read.catalogId, "nvidia-nim");
    assert.equal(read.keyCount.total, 1);
    assert.equal(read.keyCount.enabled, 1);
    const keys = listProviderKeys(db, read.id);
    assert.equal(keys[0].credential, "nvapi-x");
  } finally {
    closeDatabase(db);
  }
});

test("catalogId is nullable for legacy/config providers", () => {
  const db = freshDb();
  try {
    const p = createProvider(db, {
      name: "Legacy",
      baseUrl: "https://example.com",
    });
    assert.equal(p.catalogId, null);
    assert.equal(getProvider(db, p.id)!.catalogId, null);
  } finally {
    closeDatabase(db);
  }
});

test("updateProvider preserves catalogId when omitted, updates when set", () => {
  const db = freshDb();
  try {
    const p = createProvider(db, {
      name: "p",
      baseUrl: "https://a.example.com",
      catalogId: "openai",
    });
    // Partial update that doesn't touch catalogId keeps it.
    const u1 = updateProvider(db, p.id, { name: "p", baseUrl: p.baseUrl })!;
    assert.equal(u1.catalogId, "openai");
    // Explicitly clearing it.
    const u2 = updateProvider(db, p.id, {
      name: "p",
      baseUrl: p.baseUrl,
      catalogId: null,
    })!;
    assert.equal(u2.catalogId, null);
  } finally {
    closeDatabase(db);
  }
});

test("provider_keys: create with keys, disable via update, preserved on unrelated update", () => {
  const db = freshDb();
  try {
    const p = createProvider(db, {
      name: "p",
      baseUrl: "https://a.example.com",
      apiKeys: ["k1", "k2"],
    });
    assert.equal(p.keyCount.enabled, 2);
    assert.equal(p.keyCount.disabled, 0);

    // Toggle k2 off via the legacy shim.
    const u1 = updateProvider(db, p.id, {
      apiKeys: ["k1"],
      disabledApiKeys: ["k2"],
    })!;
    assert.equal(u1.keyCount.enabled, 1);
    assert.equal(u1.keyCount.disabled, 1);
    const keys1 = listProviderKeys(db, p.id);
    assert.equal(keys1.find((k) => k.credential === "k1")!.enabled, true);
    assert.equal(keys1.find((k) => k.credential === "k2")!.enabled, false);

    // Omitting apiKeys/disabledApiKeys on a later update preserves keys.
    const u2 = updateProvider(db, p.id, { name: "p2" })!;
    assert.equal(u2.keyCount.enabled, 1);
    assert.equal(u2.keyCount.disabled, 1);
  } finally {
    closeDatabase(db);
  }
});

test("listProviders returns created rows", () => {
  const db = freshDb();
  try {
    createProvider(db, { name: "one", baseUrl: "https://one.example.com" });
    createProvider(db, { name: "two", baseUrl: "https://two.example.com" });
    const all = listProviders(db);
    assert.equal(all.length, 2);
  } finally {
    closeDatabase(db);
  }
});

test("id is decoupled from name — two same-named providers both persist", () => {
  const db = freshDb();
  try {
    const a = createProvider(db, {
      name: "OpenAI",
      baseUrl: "https://api.openai.com",
      catalogId: "openai",
    });
    const b = createProvider(db, {
      name: "OpenAI",
      baseUrl: "https://api.openai.com",
      catalogId: "openai",
    });
    assert.notEqual(a.id, b.id); // distinct ids despite same name + catalog
    assert.equal(a.name, "OpenAI");
    assert.equal(b.name, "OpenAI");
    assert.equal(listProviders(db).length, 2);
    // Both keep their own row.
    assert.equal(getProvider(db, a.id)!.catalogId, "openai");
    assert.equal(getProvider(db, b.id)!.catalogId, "openai");
  } finally {
    closeDatabase(db);
  }
});

test("format is nullable — omitted stores null, not 'openai'", () => {
  const db = freshDb();
  try {
    const p = createProvider(db, {
      name: "Adapter-backed",
      baseUrl: "https://x.example.com",
      catalogId: "openai",
    });
    assert.equal(p.format, null);
    assert.equal(getProvider(db, p.id)!.format, null);
    // Explicitly set + then cleared.
    const withFmt = createProvider(db, {
      name: "Generic",
      baseUrl: "https://y.example.com",
      format: "anthropic",
    });
    assert.equal(withFmt.format, "anthropic");
    const cleared = updateProvider(db, withFmt.id, { format: null })!;
    assert.equal(cleared.format, null);
  } finally {
    closeDatabase(db);
  }
});

test("endpoints round-trip as wire KINDS; endpointPaths override persists", () => {
  const db = freshDb();
  try {
    const p = createProvider(db, {
      name: "Kinds",
      baseUrl: "https://x.example.com",
      endpoints: ["chat", "responses"],
      endpointPaths: { chat: "/api/v2/chat" },
    });
    assert.deepEqual(p.endpoints, ["chat", "responses"]);
    assert.deepEqual(p.endpointPaths, { chat: "/api/v2/chat" });
    const read = getProvider(db, p.id)!;
    assert.deepEqual(read.endpoints, ["chat", "responses"]);
    assert.deepEqual(read.endpointPaths, { chat: "/api/v2/chat" });
  } finally {
    closeDatabase(db);
  }
});

test("legacy path-string endpoints are read back as kinds (migration-tolerant map)", () => {
  const db = freshDb();
  try {
    // Simulate a pre-migration row by writing path strings directly.
    const p = createProvider(db, {
      name: "Legacy",
      baseUrl: "https://x.example.com",
    });
    db.prepare("UPDATE providers SET endpoints=? WHERE id=?").run(
      JSON.stringify(["/v1/chat/completions", "/v1/responses"]),
      p.id,
    );
    const read = getProvider(db, p.id)!;
    assert.deepEqual(read.endpoints, ["chat", "responses"]);
  } finally {
    closeDatabase(db);
  }
});

// --- normBasePath ------------------------------------------------------------
// basePath REPLACES the implicit "/v1" prefix (see standardPath in
// providers/base.ts) — it must compose cleanly as `origin + basePath + suffix`,
// so normBasePath's job is: trim, force a leading slash, strip trailing
// slashes, and treat a bare "/" the same as unset (empty = "use the implicit
// /v1 default", not "route to the bare origin with a dangling slash").

test("normBasePath: empty/undefined/null all normalize to empty (implicit /v1 default)", () => {
  assert.equal(normBasePath(""), "");
  assert.equal(normBasePath(undefined), "");
  assert.equal(normBasePath(null), "");
  assert.equal(normBasePath("   "), "");
});

test("normBasePath: a bare '/' is treated as unset, not a one-char path", () => {
  assert.equal(normBasePath("/"), "");
});

test("normBasePath: a value with no leading slash gets one added", () => {
  assert.equal(normBasePath("v1beta/openai"), "/v1beta/openai");
});

test("normBasePath: trailing slash(es) are stripped so composeUrl never double-slashes", () => {
  assert.equal(normBasePath("/api/coding/paas/v4/"), "/api/coding/paas/v4");
  assert.equal(normBasePath("/api//"), "/api");
});

test("normBasePath: surrounding whitespace is trimmed", () => {
  assert.equal(normBasePath("  /v1beta/openai  "), "/v1beta/openai");
});

test("normBasePath: an already-clean value passes through unchanged", () => {
  assert.equal(normBasePath("/v1beta/openai"), "/v1beta/openai");
});

test("createProvider normalizes basePath on write (trailing slash stripped)", () => {
  const db = freshDb();
  try {
    const p = createProvider(db, {
      name: "GLM",
      baseUrl: "https://api.z.ai",
      basePath: "/api/coding/paas/v4/",
    });
    assert.equal(p.basePath, "/api/coding/paas/v4");
  } finally {
    closeDatabase(db);
  }
});

test("updateProvider normalizes basePath on write (missing leading slash added)", () => {
  const db = freshDb();
  try {
    const p = createProvider(db, {
      name: "Custom",
      baseUrl: "https://api.example.com",
    });
    const updated = updateProvider(db, p.id, { basePath: "v1beta/openai" });
    assert.equal(updated!.basePath, "/v1beta/openai");
  } finally {
    closeDatabase(db);
  }
});
