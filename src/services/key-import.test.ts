import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, closeDatabase } from "../db";
import { createProvider } from "../repo/providers";
import { createProviderKey, listProviderKeys } from "../repo/provider-keys";
import { parseKeysFromResponse, reconcileImportedKeys } from "./key-import";

test("poll parser accepts a JSON string array and applies default metadata", () => {
  assert.deepEqual(
    parseKeysFromResponse(JSON.stringify([" sk-one ", "", "sk-two"]), {
      source: "poll",
    }),
    [
      { credential: "sk-one", metadata: { source: "poll" } },
      { credential: "sk-two", metadata: { source: "poll" } },
    ],
  );
});

test("poll parser accepts object arrays, key alias, labels, enabled state, and per-key metadata", () => {
  const parsed = parseKeysFromResponse(
    JSON.stringify([
      {
        credential: "sk-one",
        label: "primary",
        enabled: false,
        metadata: { uuid: "u-1", email: "owner@example.com", ignored: 42 },
      },
      {
        key: "sk-two",
        metadata: { source: "per-key" },
      },
      { nope: "ignored" },
    ]),
    { source: "default", region: "us" },
  );

  assert.deepEqual(parsed, [
    {
      credential: "sk-one",
      enabled: false,
      label: "primary",
      metadata: {
        source: "default",
        region: "us",
        uuid: "u-1",
        email: "owner@example.com",
      },
    },
    {
      credential: "sk-two",
      enabled: undefined,
      label: undefined,
      metadata: { source: "per-key", region: "us" },
    },
  ]);
});

test("poll parser accepts newline text and skips blanks and comments", () => {
  assert.deepEqual(
    parseKeysFromResponse(
      "# production\n sk-one \n\n# disabled upstream\nsk-two\r\n",
    ),
    [
      { credential: "sk-one", metadata: undefined },
      { credential: "sk-two", metadata: undefined },
    ],
  );
});

test("poll parser returns an empty list for empty input", () => {
  assert.deepEqual(parseKeysFromResponse("  \n  "), []);
});

function setupProvider() {
  const db = openDatabase(":memory:");
  createProvider(db, {
    id: "provider-1",
    name: "Provider",
    baseUrl: "https://example.com",
  });
  return db;
}

test("replace reconciliation refreshes metadata and respects explicit disabled state", () => {
  const db = setupProvider();
  try {
    createProviderKey(db, "provider-1", {
      credential: "sk-one",
      metadata: { uuid: "old" },
      label: "old-label",
    });
    createProviderKey(db, "provider-1", { credential: "sk-missing" });

    const result = reconcileImportedKeys(
      db,
      "provider-1",
      [
        {
          credential: "sk-one",
          enabled: false,
          metadata: { uuid: "new", email: "owner@example.com" },
          label: "new-label",
        },
      ],
      "replace",
    );

    assert.equal(result.updated, 1);
    assert.equal(result.disabled, 1);
    const [one, missing] = listProviderKeys(db, "provider-1");
    assert.equal(one.enabled, false);
    assert.equal(one.label, "new-label");
    assert.deepEqual(one.metadata, {
      uuid: "new",
      email: "owner@example.com",
    });
    assert.equal(missing.enabled, false);
  } finally {
    closeDatabase(db);
  }
});

test("empty replace response disables every key", () => {
  const db = setupProvider();
  try {
    createProviderKey(db, "provider-1", { credential: "sk-one" });
    createProviderKey(db, "provider-1", { credential: "sk-two" });
    const result = reconcileImportedKeys(db, "provider-1", [], "replace");
    assert.equal(result.disabled, 2);
    assert.ok(listProviderKeys(db, "provider-1").every((key) => !key.enabled));
  } finally {
    closeDatabase(db);
  }
});

test("append reconciliation updates only fields supplied by the source", () => {
  const db = setupProvider();
  try {
    createProviderKey(db, "provider-1", {
      credential: "sk-one",
      enabled: false,
      label: "keep-me",
      metadata: { uuid: "old" },
    });
    reconcileImportedKeys(
      db,
      "provider-1",
      [{ credential: "sk-one", metadata: { uuid: "new" } }],
      "append",
    );
    const [saved] = listProviderKeys(db, "provider-1");
    assert.equal(saved.enabled, false);
    assert.equal(saved.label, "keep-me");
    assert.deepEqual(saved.metadata, { uuid: "new" });
  } finally {
    closeDatabase(db);
  }
});
