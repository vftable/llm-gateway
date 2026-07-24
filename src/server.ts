// Express application assembly.
//
//   /api/*      — admin REST API (dashboard backend)
//   /v1/*       — LLM gateway proxy surface (multi-provider engine)
//   /health     — liveness
//   /*          — built frontend SPA (production), served from web/dist
//
// In dev the Vite dev server (port 5173) proxies /api and /v1 to this backend,
// so the SPA and gateway share an origin. In production this single server
// serves everything.

import fs from "fs";
import path from "path";
import express, { type Express } from "express";
import type { Database as DB } from "better-sqlite3";
import type { Logger } from "./logger";
import type { GatewayRouter } from "./gateway/router";
import type { AdminAuth } from "./auth/admin-auth";
import { adminRouter } from "./admin/routes";
import type { BroadcastFn } from "./admin/routes/types";
import type { KeySyncService } from "./services/key-sync";
import type { BootstrapConfig } from "./config";

export function createServerApp(
  db: DB,
  logger: Logger,
  router: GatewayRouter,
  auth: AdminAuth,
  opts: BootstrapConfig,
  broadcast?: BroadcastFn,
  keySyncService?: KeySyncService,
): Express {
  const app = express();

  // Global request logger — Morgan-style colorized line for every request.
  app.use(logger.httpMiddleware());

  // JSON body parsing for the admin API and gateway /v1 surface. (The gateway
  // router re-applies its own /v1 body parser with a large limit; keep this
  // one modest for /api.)
  app.use("/api", express.json({ limit: "4mb" }));

  // Permissive CORS for the admin API in dev (Vite on another origin).
  if (opts.corsOrigin) {
    const origin = opts.corsOrigin;
    app.use("/api", (_req, res, next) => {
      res.header("Access-Control-Allow-Origin", origin);
      res.header(
        "Access-Control-Allow-Headers",
        "content-type, authorization, x-admin-token",
      );
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
      );
      if (_req.method === "OPTIONS") return res.sendStatus(204);
      next();
    });
  }

  // Admin API.
  app.use(
    "/api",
    adminRouter(db, logger, router, auth, opts, broadcast, keySyncService),
  );

  // Gateway /v1 surface.
  router.register(app);

  // Health.
  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Static frontend (production build), served under opts.webBasePath
  // ("/" by default). index.html is rewritten once at boot to carry
  // <base href> so the relative-base build works under any prefix without a
  // rebuild; the SPA reads the prefix from document.baseURI.
  if (fs.existsSync(opts.webDistDir)) {
    const base = opts.webBasePath; // "/" or "/admin/"
    const mount = base.slice(0, -1) || "/"; // "/admin" or "/"

    let indexHtml = fs.readFileSync(
      path.join(opts.webDistDir, "index.html"),
      "utf8",
    );
    // Always inject <base href>, including when base is "/". The production
    // build uses relative asset URLs (./assets/…); without a base tag those
    // resolve against the current document path, so a refresh on a nested
    // SPA route (e.g. /providers/abc) looks for /providers/assets/… and
    // fails. document.baseURI also feeds BrowserRouter's basename via
    // webBase(), so a missing tag corrupts routing depth under nested URLs.
    indexHtml = indexHtml.replace(
      /<head(\s[^>]*)?>/i,
      (m) => `${m}<base href="${base}">`,
    );
    const sendIndex = (_req: express.Request, res: express.Response) =>
      res.type("html").send(indexHtml);

    // index:false so directory requests fall through to sendIndex (with the
    // injected <base>) instead of serving the raw index.html.
    app.use(mount, express.static(opts.webDistDir, { index: false }));
    if (base === "/") {
      app.get("*", (req, res, next) => {
        // Don't hijack API/gateway routes that already 404'd.
        if (req.path.startsWith("/api") || req.path.startsWith("/v1"))
          return next();
        sendIndex(req, res);
      });
    } else {
      app.get([mount, `${base}*`], sendIndex);
    }
  }

  // 404 for unmatched API/gateway paths.
  app.use((req, res) => {
    res.status(404).json({
      error: {
        type: "not_found",
        message: `Unknown path: ${req.method} ${req.path}`,
      },
    });
  });

  // Final error handler (4-arg, registered last).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use(
    (
      err: unknown,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      const e = err as { type?: string; status?: number; message?: string };
      const isBodyErr =
        e &&
        (e.type === "entity.parse.failed" ||
          e.type === "entity.too.large" ||
          e.type === "entity.verify.failed");
      if (isBodyErr && !res.headersSent) {
        return res.status(e!.status || 400).json({
          error: {
            type: e!.type || "bad_request",
            message: e!.message || "Malformed body",
          },
        });
      }
      logger.error("unhandled_error", {
        path: req.originalUrl,
        err: (err as Error)?.stack || String(err),
      });
      if (!res.headersSent)
        res.status(500).json({
          error: { type: "internal_error", message: "Internal error" },
        });
    },
  );

  return app;
}
