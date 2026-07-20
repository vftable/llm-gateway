import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, closeDatabase } from "../db";
import { createProvider } from "./providers";
import { batchModelLinks, createModel, getModel } from "./models";

function setup() {
  const db = openDatabase(":memory:");
  for (const id of ["p1", "p2", "p3"]) {
    createProvider(db, {
      id,
      name: id,
      baseUrl: `https://${id}.example.com`,
    });
  }
  const model = createModel(db, {
    id: "model-1",
    alias: "model",
    providers: [
      { providerId: "p1", upstreamModel: "a" },
      { providerId: "p2", upstreamModel: "b" },
    ],
  });
  return { db, model };
}

test("model-link batch adds, updates, removes, and reorders a subset atomically", () => {
  const { db, model } = setup();
  try {
    const result = batchModelLinks(db, model.id, {
      add: [{ providerId: "p3", upstreamModel: "c", enabled: false }],
      update: [
        {
          providerId: "p1",
          upstreamModel: "a",
          endpoint: "/custom",
          contextWindow: 200000,
        },
      ],
      remove: [{ providerId: "p2", upstreamModel: "b" }],
      reorder: [{ providerId: "p3", upstreamModel: "c" }],
    });

    assert.deepEqual(
      {
        added: result.added,
        updated: result.updated,
        removed: result.removed,
        reordered: result.reordered,
      },
      { added: 1, updated: 1, removed: 1, reordered: 1 },
    );
    assert.deepEqual(
      result.model.providers.map((link) => [
        link.providerId,
        link.upstreamModel,
        link.priority,
      ]),
      [
        ["p3", "c", 0],
        ["p1", "a", 1],
      ],
    );
    const updated = result.model.providers[1];
    assert.equal(updated.endpoint, "/custom");
    assert.equal(updated.contextWindow, 200000);
  } finally {
    closeDatabase(db);
  }
});

test("model-link batch rolls back all writes on an invalid identity", () => {
  const { db, model } = setup();
  try {
    assert.throws(() =>
      batchModelLinks(db, model.id, {
        add: [{ providerId: "p3", upstreamModel: "c" }],
        update: [
          { providerId: "missing", upstreamModel: "nope", enabled: false },
        ],
      }),
    );
    assert.deepEqual(
      getModel(db, model.id)!.providers.map((link) => [
        link.providerId,
        link.upstreamModel,
      ]),
      [
        ["p1", "a"],
        ["p2", "b"],
      ],
    );
  } finally {
    closeDatabase(db);
  }
});

test("model-link reorder rejects duplicate identities without changing priorities", () => {
  const { db, model } = setup();
  try {
    const duplicate = { providerId: "p2", upstreamModel: "b" };
    assert.throws(() =>
      batchModelLinks(db, model.id, { reorder: [duplicate, duplicate] }),
    );
    assert.deepEqual(
      getModel(db, model.id)!.providers.map((link) => link.providerId),
      ["p1", "p2"],
    );
  } finally {
    closeDatabase(db);
  }
});
