// Users repository.

import type { Database as DB } from "better-sqlite3";
import type { User } from "../types";
import { slugify } from "./providers";

interface UserRow {
  id: string;
  name: string;
  email: string | null;
  enabled: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function mapUser(r: UserRow): User {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    enabled: !!r.enabled,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listUsers(db: DB): User[] {
  const rows = db
    .prepare("SELECT * FROM users ORDER BY name")
    .all() as UserRow[];
  return rows.map(mapUser);
}

export function getUser(db: DB, id: string): User | null {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as
    UserRow | undefined;
  return row ? mapUser(row) : null;
}

export interface UserInput {
  id?: string;
  name: string;
  email?: string | null;
  enabled?: boolean;
  notes?: string | null;
}

export function createUser(db: DB, input: UserInput): User {
  const now = new Date().toISOString();
  const id = input.id || slugify(input.name) || `user-${Date.now()}`;
  if (getUser(db, id)) throw new Error(`User '${id}' already exists`);
  db.prepare(
    `INSERT INTO users (id, name, email, enabled, notes, created_at, updated_at)
     VALUES (@id, @name, @email, @enabled, @notes, @created_at, @updated_at)`,
  ).run({
    id,
    name: input.name,
    email: input.email ?? null,
    enabled: input.enabled === false ? 0 : 1,
    notes: input.notes ?? null,
    created_at: now,
    updated_at: now,
  });
  return getUser(db, id)!;
}

export function updateUser(
  db: DB,
  id: string,
  input: Partial<UserInput>,
): User | null {
  const existing = getUser(db, id);
  if (!existing) return null;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE users SET name=@name, email=@email, enabled=@enabled, notes=@notes, updated_at=@updated_at
     WHERE id=@id`,
  ).run({
    id,
    name: input.name ?? existing.name,
    email: input.email !== undefined ? input.email : existing.email,
    enabled:
      input.enabled !== undefined
        ? input.enabled
          ? 1
          : 0
        : existing.enabled
          ? 1
          : 0,
    notes: input.notes !== undefined ? input.notes : existing.notes,
    updated_at: now,
  });
  return getUser(db, id);
}

export function deleteUser(db: DB, id: string): boolean {
  const r = db.prepare("DELETE FROM users WHERE id = ?").run(id);
  return r.changes > 0;
}
