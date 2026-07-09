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
} from "./providers";

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
    assert.deepEqual(read.apiKeys, ["nvapi-x"]);
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
