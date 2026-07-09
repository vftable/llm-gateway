// Provider-models repo + chain link-override tests against an in-memory DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, closeDatabase } from "../db";
import { createProvider } from "./providers";
import { createModel, getModel } from "./models";
import {
  listProviderModels,
  upsertProviderModel,
  updateProviderModel,
  deleteProviderModel,
  getProviderModel,
} from "./provider-models";

function freshDb() {
  const db = openDatabase(":memory:");
  createProvider(db, { name: "zai", baseUrl: "https://api.z.ai" });
  return db;
}

test("upsertProviderModel creates then updates by (provider, upstream)", () => {
  const db = freshDb();
  try {
    const a = upsertProviderModel(db, {
      providerId: "zai",
      upstreamId: "glm-4.6",
      contextWindow: 200000,
    });
    assert.equal(a.upstreamId, "glm-4.6");
    assert.equal(a.contextWindow, 200000);
    // second upsert with same identity updates, doesn't duplicate
    const b = upsertProviderModel(db, {
      providerId: "zai",
      upstreamId: "glm-4.6",
      displayName: "GLM 4.6",
    });
    assert.equal(b.id, a.id);
    assert.equal(b.displayName, "GLM 4.6");
    assert.equal(b.contextWindow, 200000); // preserved
    assert.equal(listProviderModels(db, "zai").length, 1);
  } finally {
    closeDatabase(db);
  }
});

test("transforms round-trip as JSON", () => {
  const db = freshDb();
  try {
    const pm = upsertProviderModel(db, {
      providerId: "zai",
      upstreamId: "glm-4.6",
      transforms: [
        { id: "clamp-number", phase: "request", params: { path: "max_tokens", max: 8192 } },
      ],
    });
    const read = getProviderModel(db, "zai", "glm-4.6")!;
    assert.deepEqual(read.transforms, pm.transforms);
    assert.equal(read.transforms[0].id, "clamp-number");
  } finally {
    closeDatabase(db);
  }
});

test("update + delete", () => {
  const db = freshDb();
  try {
    const pm = upsertProviderModel(db, { providerId: "zai", upstreamId: "m" });
    const up = updateProviderModel(db, pm.id, { maxOutputTokens: 4096 })!;
    assert.equal(up.maxOutputTokens, 4096);
    assert.ok(deleteProviderModel(db, pm.id));
    assert.equal(listProviderModels(db, "zai").length, 0);
  } finally {
    closeDatabase(db);
  }
});

test("imported models are scoped per provider (cascade on provider delete)", () => {
  const db = freshDb();
  try {
    createProvider(db, { name: "other", baseUrl: "https://x.example.com" });
    upsertProviderModel(db, { providerId: "zai", upstreamId: "a" });
    upsertProviderModel(db, { providerId: "other", upstreamId: "a" });
    assert.equal(listProviderModels(db, "zai").length, 1);
    assert.equal(listProviderModels(db, "other").length, 1);
  } finally {
    closeDatabase(db);
  }
});

test("same provider can appear multiple times in a chain (distinct upstreams)", () => {
  const db = freshDb();
  try {
    const m = createModel(db, {
      alias: "multi",
      providers: [
        { providerId: "zai", upstreamModel: "glm-4.6", contextWindow: 200000 },
        { providerId: "zai", upstreamModel: "glm-4.5", contextWindow: 64000 },
      ],
    });
    const links = getModel(db, m.id)!.providers;
    assert.equal(links.length, 2);
    // Order preserved, each keeps its own override.
    assert.equal(links[0].upstreamModel, "glm-4.6");
    assert.equal(links[0].contextWindow, 200000);
    assert.equal(links[1].upstreamModel, "glm-4.5");
    assert.equal(links[1].contextWindow, 64000);
  } finally {
    closeDatabase(db);
  }
});

test("chain link context-window + max-output overrides persist", () => {
  const db = freshDb();
  try {
    const m = createModel(db, {
      alias: "glm",
      providers: [
        {
          providerId: "zai",
          upstreamModel: "glm-4.6",
          contextWindow: 128000,
          maxOutputTokens: 32000,
        },
      ],
    });
    const link = getModel(db, m.id)!.providers[0];
    assert.equal(link.contextWindow, 128000);
    assert.equal(link.maxOutputTokens, 32000);
    // null overrides are allowed (inherit)
    const m2 = createModel(db, {
      alias: "glm2",
      providers: [{ providerId: "zai", upstreamModel: "glm-4.6" }],
    });
    const link2 = getModel(db, m2.id)!.providers[0];
    assert.equal(link2.contextWindow, null);
    assert.equal(link2.maxOutputTokens, null);
  } finally {
    closeDatabase(db);
  }
});
