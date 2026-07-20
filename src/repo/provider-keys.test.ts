import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, closeDatabase } from "../db";
import { createProvider } from "./providers";
import {
  batchProviderKeys,
  countProviderKeys,
  createProviderKey,
  credHash,
  getProviderKey,
  listEnabledCredentials,
  listProviderKeys,
} from "./provider-keys";

function setup() {
  const db = openDatabase(":memory:");
  createProvider(db, {
    id: "provider-1",
    name: "Provider",
    baseUrl: "https://example.com",
  });
  return db;
}

test("provider keys persist structured metadata, label, hash, and enabled state", () => {
  const db = setup();
  try {
    const key = createProviderKey(db, "provider-1", {
      credential: "sk-structured",
      enabled: false,
      label: "billing-primary",
      metadata: { uuid: "u-1", email: "owner@example.com" },
    });

    assert.equal(key.credHash, credHash("sk-structured"));
    assert.equal(key.enabled, false);
    assert.equal(key.label, "billing-primary");
    assert.deepEqual(key.metadata, {
      uuid: "u-1",
      email: "owner@example.com",
    });
    assert.deepEqual(countProviderKeys(db, "provider-1"), {
      enabled: 0,
      disabled: 1,
      total: 1,
    });
    assert.deepEqual(listEnabledCredentials(db, "provider-1"), []);
  } finally {
    closeDatabase(db);
  }
});

test("provider-key batch is atomic, deduplicates credentials, and applies all operation types", () => {
  const db = setup();
  try {
    const seed = batchProviderKeys(db, "provider-1", {
      add: [
        { credential: "sk-a", metadata: { uuid: "a" } },
        { credential: "sk-b", label: "backup" },
        { credential: "sk-a", metadata: { uuid: "duplicate" } },
      ],
    });
    assert.equal(seed.added, 2);
    assert.equal(seed.duplicatesSkipped, 1);

    const [a, b] = listProviderKeys(db, "provider-1");
    const result = batchProviderKeys(db, "provider-1", {
      update: [
        {
          id: a.id,
          metadata: { uuid: "a2", email: "a@example.com" },
          label: "primary",
        },
      ],
      disable: [a.id],
      enable: [b.id],
      remove: [b.id],
    });

    assert.equal(result.updated, 1);
    assert.equal(result.disabled, 1);
    assert.equal(result.enabled, 1);
    assert.equal(result.removed, 1);
    assert.equal(result.keys.length, 1);
    const saved = getProviderKey(db, a.id)!;
    assert.equal(saved.enabled, false);
    assert.equal(saved.label, "primary");
    assert.deepEqual(saved.metadata, {
      uuid: "a2",
      email: "a@example.com",
    });
  } finally {
    closeDatabase(db);
  }
});

test("provider-key batch rolls back writes when an unexpected operation fails", () => {
  const db = setup();
  try {
    assert.throws(() =>
      batchProviderKeys(db, "provider-1", {
        add: [
          { credential: "sk-valid" },
          {
            credential: "sk-invalid",
            metadata: { broken: BigInt(1) as unknown as string },
          },
        ],
      }),
    );
    assert.deepEqual(listProviderKeys(db, "provider-1"), []);
  } finally {
    closeDatabase(db);
  }
});
