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
  // Explicit id so the model rows below can reference "zai" (ids are otherwise
  // randomly generated, decoupled from name).
  createProvider(db, { id: "zai", name: "zai", baseUrl: "https://api.z.ai" });
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
        {
          id: "clamp-number",
          phase: "request",
          params: { path: "max_tokens", max: 8192 },
        },
      ],
    });
    const read = getProviderModel(db, "zai", "glm-4.6")!;
    assert.deepEqual(read.transforms, pm.transforms);
    assert.equal(read.transforms[0].id, "clamp-number");
  } finally {
    closeDatabase(db);
  }
});

test("capabilities round-trip as JSON, default null, preserved on partial update", () => {
  const db = freshDb();
  try {
    // Default: no capabilities → null.
    const bare = upsertProviderModel(db, {
      providerId: "zai",
      upstreamId: "glm-plain",
    });
    assert.equal(bare.capabilities, null);

    // Import with a rich capability object.
    const caps = {
      batch: { supported: true },
      citations: { supported: false },
      code_execution: { supported: true },
      image_input: { supported: true },
      pdf_input: { supported: false },
      structured_outputs: { supported: true },
      thinking: {
        supported: true,
        types: { adaptive: { supported: true }, enabled: { supported: false } },
      },
      effort: {
        supported: true,
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
        xhigh: { supported: false },
        max: { supported: false },
      },
    };
    const rich = upsertProviderModel(db, {
      providerId: "zai",
      upstreamId: "glm-rich",
      capabilities: caps,
    });
    const read = getProviderModel(db, "zai", "glm-rich")!;
    assert.deepEqual(read.capabilities, caps);

    // A partial update that omits capabilities preserves them.
    const patched = updateProviderModel(db, rich.id, { displayName: "GLM" })!;
    assert.deepEqual(patched.capabilities, caps);

    // Explicit null clears them.
    const cleared = updateProviderModel(db, rich.id, { capabilities: null })!;
    assert.equal(cleared.capabilities, null);
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
    createProvider(db, {
      id: "other",
      name: "other",
      baseUrl: "https://x.example.com",
    });
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
