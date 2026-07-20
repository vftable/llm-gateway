// User + API-key CRUD routes.

import {
  createUser,
  deleteUser,
  listUsers,
  updateUser,
} from "../../repo/users";
import {
  createApiKey,
  deleteApiKey,
  listApiKeys,
  updateApiKey,
} from "../../repo/api-keys";
import type { RouteCtx } from "./types";
import {
  parseUserInput,
  parseApiKeyInput,
  parseBatchApiKeyOps,
} from "./parsers";
import { bad } from "./respond";

export function registerUserRoutes(ctx: RouteCtx): void {
  const { db, router, r, requireAdmin, broadcast } = ctx;

  // --- users ---
  r.get("/users", requireAdmin, (_req, res) => res.json(listUsers(db)));

  r.post("/users", requireAdmin, (req, res) => {
    try {
      const u = createUser(db, parseUserInput(req.body, true));
      res.status(201).json(u);
    } catch (e) {
      bad(res, e);
    }
  });

  r.put("/users/:id", requireAdmin, (req, res) => {
    try {
      const u = updateUser(db, String(req.params.id), parseUserInput(req.body));
      if (!u) return res.status(404).json({ error: { message: "not found" } });
      res.json(u);
    } catch (e) {
      bad(res, e);
    }
  });

  r.delete("/users/:id", requireAdmin, (req, res) => {
    if (!deleteUser(db, String(req.params.id)))
      return res.status(404).json({ error: { message: "not found" } });
    res.status(204).end();
  });

  // --- api keys ---
  r.get("/api-keys", requireAdmin, (_req, res) => res.json(listApiKeys(db)));

  r.post("/api-keys", requireAdmin, (req, res) => {
    try {
      const input = parseApiKeyInput(req.body);
      const key = createApiKey(db, input);
      router.reload();
      broadcast(["keys", "overview"], "key:create");
      res.status(201).json(key);
    } catch (e) {
      bad(res, e);
    }
  });

  r.put("/api-keys/:id", requireAdmin, (req, res) => {
    try {
      const k = updateApiKey(
        db,
        String(req.params.id),
        parseApiKeyInput(req.body),
      );
      if (!k) return res.status(404).json({ error: { message: "not found" } });
      res.json(k);
    } catch (e) {
      bad(res, e);
    }
  });

  r.delete("/api-keys/:id", requireAdmin, (req, res) => {
    if (!deleteApiKey(db, String(req.params.id)))
      return res.status(404).json({ error: { message: "not found" } });
    router.reload();
    broadcast(["keys", "overview"], "key:delete");
    res.status(204).end();
  });

  // --- api keys batch ---
  r.post("/api-keys/batch", requireAdmin, (req, res) => {
    try {
      const ops = parseBatchApiKeyOps(req.body);
      const result = {
        created: [] as Array<ReturnType<typeof createApiKey>>,
        updated: [] as Array<NonNullable<ReturnType<typeof updateApiKey>>>,
        deleted: 0,
        enabled: 0,
        disabled: 0,
        errors: [] as Array<{ op: string; id?: string; detail: string }>,
      };

      const tx = db.transaction(() => {
        if (ops.create) {
          for (const input of ops.create) {
            try {
              result.created.push(createApiKey(db, input));
            } catch (e) {
              result.errors.push({
                op: "create",
                detail: (e as Error).message,
              });
            }
          }
        }
        if (ops.update) {
          for (const { id, ...input } of ops.update) {
            const updated = updateApiKey(db, id, input);
            if (updated) result.updated.push(updated);
            else result.errors.push({ op: "update", id, detail: "not found" });
          }
        }
        if (ops.enable) {
          for (const id of ops.enable) {
            const updated = updateApiKey(db, id, { enabled: true });
            if (updated) result.enabled++;
            else result.errors.push({ op: "enable", id, detail: "not found" });
          }
        }
        if (ops.disable) {
          for (const id of ops.disable) {
            const updated = updateApiKey(db, id, { enabled: false });
            if (updated) result.disabled++;
            else result.errors.push({ op: "disable", id, detail: "not found" });
          }
        }
        if (ops.delete) {
          for (const id of ops.delete) {
            if (deleteApiKey(db, id)) result.deleted++;
            else result.errors.push({ op: "delete", id, detail: "not found" });
          }
        }
      });
      tx();

      router.reload();
      broadcast(["keys", "overview"], "key:batch");
      res.json(result);
    } catch (e) {
      bad(res, e);
    }
  });
}
