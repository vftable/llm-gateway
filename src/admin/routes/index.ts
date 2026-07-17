// Admin REST API under /api. All endpoints (except auth/login and auth/check)
// require a valid admin session token. Mutations that affect the gateway's
// live view (providers, models, settings) trigger a registry reload so changes
// take effect without a restart.
//
// Split by concern into sibling modules (settings/providers/models/users/
// usage) — this file only wires the shared RouteCtx and registers each
// group's routes onto one Router.

import { Router } from "express";
import type { Database as DB } from "better-sqlite3";
import type { Logger } from "../../logger";
import type { GatewayRouter } from "../../gateway/router";
import type { AdminAuth } from "../../auth/admin-auth";
import { adminAuthMiddleware } from "../../auth/admin-auth";
import type { RouteCtx, BroadcastFn } from "./types";
import { registerSettingsRoutes } from "./settings";
import { registerProviderRoutes } from "./providers";
import { registerModelRoutes } from "./models";
import { registerUserRoutes } from "./users";
import { registerUsageRoutes } from "./usage";

const noop: BroadcastFn = () => {};

export function adminRouter(
  db: DB,
  logger: Logger,
  router: GatewayRouter,
  auth: AdminAuth,
  broadcast?: BroadcastFn,
): Router {
  const r = Router();
  const requireAdmin = adminAuthMiddleware(auth.secret);
  const ctx: RouteCtx = {
    db,
    logger,
    router,
    r,
    requireAdmin,
    broadcast: broadcast ?? noop,
  };

  registerSettingsRoutes(ctx, auth);
  registerProviderRoutes(ctx);
  registerModelRoutes(ctx);
  registerUserRoutes(ctx);
  registerUsageRoutes(ctx);

  return r;
}
