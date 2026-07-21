// Usage summary/breakdown, request-log listing, and maintenance routes.

import {
  listUsageToday,
  totalUsageHistory,
  totalUsageToday,
  fullBreakdownToday,
  breakdownForKey,
  modelResolution,
  rebuildUsageFromLogs,
} from "../../repo/usage";
import {
  listRequestLogs,
  clearRequestLogs,
  getRequestLogDetail,
} from "../../repo/request-logs";
import { vacuumFreePages } from "../../db";
import { clearAllUnifiedUsage } from "../../repo/provider-key-usage";
import type { RouteCtx } from "./types";
import { bad } from "./respond";

export function registerUsageRoutes(ctx: RouteCtx): void {
  const { db, logger, router, r, requireAdmin, broadcast } = ctx;

  // --- usage ---
  r.get("/usage", requireAdmin, (_req, res) =>
    res.json({
      today: {
        total: totalUsageToday(db),
        keys: listUsageToday(db),
      },
      history: totalUsageHistory(db, 14),
    }),
  );

  // Per-(key, model, provider) breakdown for today — answers "this key using
  // gpt-5.5 resolved to which provider and how many tokens".
  r.get("/usage/breakdown", requireAdmin, (_req, res) =>
    res.json({ rows: fullBreakdownToday(db) }),
  );

  // Breakdown for a single key (today): which models + providers it used.
  r.get("/usage/keys/:id", requireAdmin, (req, res) =>
    res.json({ rows: breakdownForKey(db, String(req.params.id)) }),
  );

  // "If a user uses model X, what provider did it resolve to?" — per-provider
  // token/request totals for a model (today).
  r.get("/usage/models/:model", requireAdmin, (req, res) =>
    res.json({
      model: req.params.model,
      rows: modelResolution(db, String(req.params.model)),
    }),
  );

  // --- request logs ---
  r.get("/request-logs", requireAdmin, (req, res) => {
    const q = req.query as {
      limit?: string;
      offset?: string;
      apiKeyId?: string;
      model?: string;
      providerId?: string;
      error?: string;
    };
    res.json(
      listRequestLogs(db, {
        limit: q.limit ? parseInt(q.limit, 10) : 100,
        offset: q.offset ? parseInt(q.offset, 10) : 0,
        apiKeyId: q.apiKeyId,
        modelId: q.model,
        providerId: q.providerId,
        statusError: q.error === "1" || q.error === "true",
      }),
    );
  });

  // Captured request/response debug payloads for one log row, loaded on demand
  // when a row is expanded (kept out of the list to keep the feed light).
  r.get("/request-logs/:id/detail", requireAdmin, (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id))
      return res.status(400).json({ error: { message: "bad id" } });
    const detail = getRequestLogDetail(db, id);
    if (!detail)
      return res.status(404).json({ error: { message: "not found" } });
    res.json(detail);
  });

  // --- maintenance ---
  // Recompute the usage + usage_breakdown counters from request_logs (the
  // ground-truth per-request record). Fixes any drift from older builds or a
  // crash between reserve and settle. `?day=YYYY-MM-DD` scopes to one UTC day;
  // omit to rebuild every day in the logs.
  r.post("/maintenance/rebuild-usage", requireAdmin, (req, res) => {
    try {
      const day = (req.query as { day?: string }).day;
      if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day))
        throw new Error("day must be YYYY-MM-DD");
      const result = rebuildUsageFromLogs(db, day);
      logger.info("usage_rebuilt", { ...result, day: day ?? "all" });
      res.json(result);
    } catch (e) {
      bad(res, e);
    }
  });

  r.post("/maintenance/clear-rate-limits", requireAdmin, (_req, res) => {
    try {
      const cleared = router.clearAllRateLimits();
      const unifiedUsageCleared = clearAllUnifiedUsage(db);
      const result = { ...cleared, unifiedUsageCleared };
      logger.info("rate_limits_cleared", result);
      broadcast(["providers", "usage"], "maintenance:clear-rate-limits");
      res.json(result);
    } catch (e) {
      bad(res, e);
    }
  });

  // Delete request logs for cleaner readings. `?scope=errors` removes only
  // failed rows; `?scope=all` clears the whole log. Frees the reclaimed pages
  // back to the OS afterward so the DB file shrinks.
  r.post("/maintenance/clear-logs", requireAdmin, (req, res) => {
    try {
      const scope = (req.query as { scope?: string }).scope ?? "errors";
      if (scope !== "errors" && scope !== "all")
        throw new Error("scope must be 'errors' or 'all'");
      const removed = clearRequestLogs(db, scope);
      if (removed > 0) vacuumFreePages(db);
      logger.info("logs_cleared", { scope, removed });
      res.json({ removed, scope });
    } catch (e) {
      bad(res, e);
    }
  });
}
