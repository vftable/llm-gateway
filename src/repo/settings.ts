// Settings repository. A typed view over the `settings` key/value table.
// Values are JSON-encoded so any type (string, number, boolean, array) can be
// stored without a column-per-field schema migration.

import type { Database as DB } from "better-sqlite3";
import { DEFAULT_SETTINGS, type Settings } from "../types";

interface Row {
  key: string;
  value: string;
}

export function getSettings(db: DB): Settings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as Row[];
  const map = new Map<string, unknown>();
  for (const r of rows) {
    try {
      map.set(r.key, JSON.parse(r.value));
    } catch {
      map.set(r.key, r.value);
    }
  }
  return {
    ...DEFAULT_SETTINGS,
    ...(Object.fromEntries(map) as Partial<Settings>),
  };
}

// Persist a partial settings update. Only the supplied keys are written.
export function saveSettings(db: DB, patch: Partial<Settings>): Settings {
  const upsert = db.prepare(
    "INSERT INTO settings(key, value) VALUES(@key, @value) " +
      "ON CONFLICT(key) DO UPDATE SET value=@value",
  );
  const tx = db.transaction((entries: Array<[string, unknown]>) => {
    for (const [key, value] of entries) {
      upsert.run({ key, value: JSON.stringify(value) });
    }
  });
  tx(Object.entries(patch));
  return getSettings(db);
}

export function getSetting<T>(db: DB, key: keyof Settings): T | undefined {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key as string) as Row | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return row.value as unknown as T;
  }
}
