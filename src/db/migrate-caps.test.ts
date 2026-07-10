// Verifies the additive capabilities migration: an OLD provider_models table
// (created without the column) gains it on the next openDatabase() migrate pass,
// and the migration is idempotent.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { openDatabase, closeDatabase } from ".";

test("capabilities column is added to a pre-existing provider_models table", () => {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "llmgw-mig-")),
    "old.db",
  );
  try {
    // Hand-build an OLD-shape provider_models table (no capabilities column).
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE providers (id TEXT PRIMARY KEY);
      CREATE TABLE provider_models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL,
        upstream_id TEXT NOT NULL,
        display_name TEXT,
        context_window INTEGER,
        max_output_tokens INTEGER,
        transforms TEXT NOT NULL DEFAULT '[]',
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const before = (
      raw.prepare("PRAGMA table_info(provider_models)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    assert.equal(before.includes("capabilities"), false);
    raw.close();

    // Open through the app: migrate() runs and adds the column.
    const db = openDatabase(file);
    const after = (
      db.prepare("PRAGMA table_info(provider_models)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    assert.equal(after.includes("capabilities"), true);
    closeDatabase(db);

    // Idempotent: opening again doesn't throw.
    const db2 = openDatabase(file);
    closeDatabase(db2);
  } finally {
    try {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test("legacy path-string endpoints migrate to kinds with byte-identical URLs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmgw-ep-"));
  const file = path.join(dir, "old.db");
  try {
    // OLD-shape providers table: endpoints stored as path strings, no
    // endpoint_paths column. Three layouts: legacy /v1, Gemini bare-suffix +
    // basePath, and a NON-standard path that must survive as an override.
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE providers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
        endpoints TEXT NOT NULL DEFAULT '[]', base_path TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    const ins = raw.prepare(
      "INSERT INTO providers (id,name,base_url,endpoints,base_path,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    );
    ins.run(
      "legacy",
      "L",
      "https://api.example.com",
      JSON.stringify(["/v1/chat/completions", "/v1/responses"]),
      "",
      "",
      "",
    );
    ins.run(
      "gemini",
      "G",
      "https://generativelanguage.googleapis.com",
      JSON.stringify(["/chat/completions"]),
      "/v1beta/openai",
      "",
      "",
    );
    ins.run(
      "weird",
      "W",
      "https://api.weird.com",
      JSON.stringify(["/api/v2/chat/completions"]),
      "",
      "",
      "",
    );
    raw.close();

    const db = openDatabase(file);
    const rows = db
      .prepare(
        "SELECT id, endpoints, endpoint_paths FROM providers ORDER BY id",
      )
      .all() as Array<{
      id: string;
      endpoints: string;
      endpoint_paths: string;
    }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    // legacy: two kinds, no overrides (standard paths).
    assert.deepEqual(JSON.parse(byId.legacy.endpoints), ["chat", "responses"]);
    assert.deepEqual(JSON.parse(byId.legacy.endpoint_paths), {});

    // gemini: chat kind; bare "/chat/completions" IS standard for a basePath
    // provider, so no override needed.
    assert.deepEqual(JSON.parse(byId.gemini.endpoints), ["chat"]);
    assert.deepEqual(JSON.parse(byId.gemini.endpoint_paths), {});

    // weird: recognizable chat suffix but a NON-standard prefix → the full path
    // is preserved as a per-kind override so the URL stays byte-identical.
    assert.deepEqual(JSON.parse(byId.weird.endpoints), ["chat"]);
    assert.deepEqual(JSON.parse(byId.weird.endpoint_paths), {
      chat: "/api/v2/chat/completions",
    });
    closeDatabase(db);
  } finally {
    // Best-effort cleanup — Windows may hold the file handle briefly.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test("legacy format NOT NULL is relaxed so a null-format provider inserts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmgw-fmt-"));
  const file = path.join(dir, "old.db");
  try {
    // OLD-shape providers table: format is NOT NULL DEFAULT 'openai'.
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE providers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
        format TEXT NOT NULL DEFAULT 'openai',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO providers (id,name,base_url,format,created_at,updated_at)
        VALUES ('old','Old','https://api.example.com','anthropic','','');
    `);
    raw.close();

    // openDatabase runs migrate() → rebuild makes format nullable.
    const db = openDatabase(file);
    const info = db.prepare("PRAGMA table_info(providers)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const fmt = info.find((c) => c.name === "format")!;
    assert.equal(fmt.notnull, 0, "format column should be nullable");

    // The pre-existing row's format is preserved.
    const kept = db
      .prepare("SELECT format FROM providers WHERE id='old'")
      .get() as { format: string | null };
    assert.equal(kept.format, "anthropic");

    // A NULL-format insert now succeeds (was: NOT NULL constraint failed).
    db.prepare(
      "INSERT INTO providers (id,name,base_url,format,created_at,updated_at) VALUES ('n','N','https://x',NULL,'','')",
    ).run();
    const got = db
      .prepare("SELECT format FROM providers WHERE id='n'")
      .get() as { format: string | null };
    assert.equal(got.format, null);
    closeDatabase(db);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});
