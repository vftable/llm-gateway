// Gateway entry point.
//
// Loads bootstrap config, opens (and seeds on first run) the SQLite database,
// initialises admin auth, wires the gateway router + admin API, and starts
// listening. Server timeouts are disabled for long-lived LLM streams.

import type { Server } from "http";
import { loadBootstrap, readConfigJson } from "./config";
import { openDatabase, closeDatabase, vacuumFreePages } from "./db";
import { syncFromConfig } from "./db/sync";
import { getSettings } from "./repo/settings";
import { initAdminAuth } from "./auth/admin-auth";
import { GatewayRouter } from "./gateway/router";
import { createServerApp } from "./server";
import { createWsServer } from "./ws/server";
import { Logger } from "./logger";
import { pruneOldLogs } from "./repo/request-logs";

function main(): void {
  const bootstrap = loadBootstrap();
  const logger = new Logger();

  const db = openDatabase(bootstrap.dbPath);

  // Sync seed data (upstream, models, gateway keys) from config.json whenever
  // the file's seed section changed since the last boot.
  if (bootstrap.configPath) {
    try {
      const res = syncFromConfig(db, readConfigJson(bootstrap.configPath));
      if (res.changed) {
        logger.info("config_synced", {
          provider: res.providerId,
          models: res.models,
          modelsRemoved: res.modelsRemoved,
          keys: res.keys,
          keysRemoved: res.keysRemoved,
        });
      }
    } catch (err) {
      logger.error("config_sync_failed", { err: (err as Error).message });
    }
  }

  const settings = getSettings(db);
  const auth = initAdminAuth(
    db,
    bootstrap.sessionTtlMs,
    bootstrap.adminPassword,
  );

  const router = new GatewayRouter(db, logger, settings.ssePingInterval);

  // Deferred broadcast: the WsHub is created after the http.Server starts,
  // but the admin routes need the broadcast function at build time. This
  // closure captures the hub reference once it's available.
  let wsHub: ReturnType<typeof createWsServer> | null = null;
  const broadcast: Parameters<typeof createServerApp>[5] = (topics, source) =>
    wsHub?.broadcast(topics, source);

  const app = createServerApp(
    db,
    logger,
    router,
    auth,
    {
      webDistDir: bootstrap.webDistDir,
      corsOrigin: bootstrap.corsOrigin,
    },
    broadcast,
  );

  logger.info("LLM Gateway starting");
  logger.info("db", { path: bootstrap.dbPath });
  logger.info("listening", { url: `http://0.0.0.0:${bootstrap.port}` });
  logger.info("auth", { configured: !!getSettings(db).adminPasswordHash });

  const server: Server = app.listen(bootstrap.port);
  configureTimeouts(server, logger);

  wsHub = createWsServer(server, db, logger, auth.secret);

  // Periodically prune request logs to the configured retention window, then
  // hand freed pages back to the OS so the file doesn't grow monotonically.
  const retentionDays = settings.requestLogRetentionDays || 30;
  const prune = () => {
    try {
      const n = pruneOldLogs(db, retentionDays);
      if (n > 0) {
        vacuumFreePages(db);
        logger.info("pruned_logs", { removed: n, retentionDays });
      }
    } catch (err) {
      logger.warn("prune_failed", { err: (err as Error).message });
    }
  };
  prune();
  const pruneTimer = setInterval(prune, 6 * 60 * 60 * 1000); // every 6h
  if (typeof (pruneTimer as { unref?: () => void }).unref === "function")
    (pruneTimer as { unref: () => void }).unref();

  // Graceful shutdown: stop accepting connections, checkpoint + close the DB
  // exactly once, then exit. The 5s timer forces exit if in-flight streams
  // won't drain; the DB is still closed cleanly on that path.
  let shuttingDown = false;
  const exit = (code: number) => {
    try {
      closeDatabase(db);
    } catch (err) {
      logger.warn("db_close_failed", { err: (err as Error).message });
    }
    process.exit(code);
  };
  const shutdown = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown", { signal: sig });
    wsHub?.shutdown();
    server.close(() => exit(0));
    setTimeout(() => exit(0), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (err) => {
    logger.error("unhandled_rejection", {
      err: (err as Error)?.stack || String(err),
    });
  });
  process.on("uncaughtException", (err) => {
    logger.error("uncaught_exception", {
      err: err?.stack || String(err),
    });
    exit(1);
  });
}

function configureTimeouts(server: Server, logger: Logger): void {
  // LLM streams can run for many minutes — disable request/headers/keepAlive
  // timeouts entirely. A 15-min socket inactivity timeout reaps truly dead
  // connections; SSE pings keep active streams alive.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;
  const INACTIVITY_MS = 15 * 60 * 1000;
  server.timeout = INACTIVITY_MS;
  server.on("connection", (socket) => socket.setKeepAlive(true, 60_000));
  logger.info("server_timeouts", {
    requestTimeout: "disabled",
    inactivityTimeout: `${INACTIVITY_MS / 1000}s`,
    tcpKeepalive: "60s probe",
  });
}

main();
