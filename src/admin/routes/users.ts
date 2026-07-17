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
  getApiKeyFull,
  listApiKeys,
  updateApiKey,
} from "../../repo/api-keys";
import type { RouteCtx } from "./types";
import { parseUserInput, parseApiKeyInput } from "./parsers";
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

  // Reveal the full key value (self-hosted admin tool — operator's own keys).
  r.get("/api-keys/:id/reveal", requireAdmin, (req, res) => {
    const full = getApiKeyFull(db, String(req.params.id));
    if (full == null)
      return res.status(404).json({ error: { message: "not found" } });
    res.json({ keyFull: full });
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
}
