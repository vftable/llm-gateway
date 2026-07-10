// Shared types + the per-request wiring every route module needs. Kept
// separate from the parsers/providers/etc. modules so they can import just
// this (no circular deps) instead of pulling in the whole barrel.

import type { Router } from "express";
import type { Database as DB } from "better-sqlite3";
import type { Logger } from "../../logger";
import type { GatewayRouter } from "../../gateway/router";
import type { RequestHandler } from "express";
import type { AuthScheme } from "../../types";
import type { ModelsFormat } from "../../providers";

// Everything a route-registration function needs: the shared db/logger/
// router the top-level adminRouter() closes over, the router instance to
// attach handlers to, and the auth guard middleware.
export interface RouteCtx {
  db: DB;
  logger: Logger;
  router: GatewayRouter;
  r: Router;
  requireAdmin: RequestHandler;
}

// Minimal provider shape the connectivity-test / model-discovery probes need
// — either a saved Provider row or an ad-hoc pre-create wizard config, which
// has no id/adapter yet.
export interface ProviderLike {
  baseUrl: string;
  host: string | null;
  apiKeys: string[];
  authScheme: AuthScheme;
  tlsVerify: boolean;
  extraHeaders: Record<string, string>;
  basePath?: string;
  modelsPath?: string;
  proxy?: string | null;
  /** Model-list dialect to fetch in (default "openai" when unset/null). */
  format?: ModelsFormat | null;
}
