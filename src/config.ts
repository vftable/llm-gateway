// Bootstrap configuration.
//
// Runtime gateway state (providers, models, keys, settings) lives in SQLite.
// `config.json` in the repo root is the single configuration file: it carries
// the bootstrap values needed to open the database and start the server
// (port, paths, admin password), and may also carry seed data (upstream,
// gatewayApiKeys, models) which is synced into the database on boot whenever
// the file changes — see db/sync.ts.
//
// No environment variables are consulted; edit config.json instead.

import fs from "fs";
import path from "path";
import crypto from "crypto";

export interface BootstrapConfig {
  port: number;
  dataDir: string;
  dbPath: string;
  webDistDir: string;
  // URL prefix the dashboard UI is served under ("/" or "/x/…/"). From
  // config.json webBasePath; boot-time only.
  webBasePath: string;
  sessionTtlMs: number;
  // If set, the SHA-256 hash of the admin password is written to settings on
  // boot (overriding whatever is stored). Plaintext is never kept in the DB.
  adminPassword: string | null;
  // Path to config.json itself (for the seed/sync step), or null when the
  // file doesn't exist.
  configPath: string | null;
  // CORS origin allowed for the admin API in dev (when the web dev server is
  // on a different port). Ignored in production (frontend served same-origin).
  corsOrigin: string | null;
}

export interface ConfigJson {
  port?: number;
  dataDir?: string;
  dbPath?: string;
  webDistDir?: string;
  webBasePath?: string;
  adminPassword?: string | null;
  corsOrigin?: string | null;
  sessionTtlHours?: number;
  // Seed data (synced into the DB when the file changes):
  upstream?: string;
  upstreamApiKey?: string;
  upstreamTlsVerify?: boolean;
  gatewayApiKeys?: unknown;
  /** Auth error returned when a known gateway API key is disabled/revoked. */
  disabledApiKeyMessage?: string;
  // Pluggable web-tools backing (seeds the webTools* / webProvider* settings).
  // `enabled` turns the feature on; `provider` picks the backend (default
  // "firecrawl"); baseUrl/apiKey are the provider's connection settings.
  // `firecrawl` is kept as a convenience alias for `enabled` (back-compat).
  webTools?: {
    enabled?: boolean;
    firecrawl?: boolean; // legacy alias for `enabled`
    provider?: string;
    baseUrl?: string;
    apiKey?: string;
    // legacy key names (still honoured):
    firecrawlBaseUrl?: string;
    firecrawlApiKey?: string;
  };
  models?: {
    mappings?: Record<string, unknown>;
    restricted?: string[];
    prefix?: string;
    exposePrefix?: string;
    exposeExempt?: string[];
    allowUnknown?: boolean;
    defaultMaxOutputTokens?: number;
  };
}

export const CONFIG_FILE = path.join(__dirname, "..", "config.json");

export function readConfigJson(file = CONFIG_FILE): ConfigJson {
  try {
    let raw = fs.readFileSync(file, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw) as ConfigJson;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // eslint-disable-next-line no-console
      console.warn(
        `[gateway] could not parse config.json: ${(err as Error).message}`,
      );
    }
    return {};
  }
}

// "/" or "/seg/…/" with both slashes. Anything non-string/blank → "/".
function normalizeBasePath(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  let p = raw.trim();
  if (!p || p === "/") return "/";
  if (!p.startsWith("/")) p = "/" + p;
  if (!p.endsWith("/")) p += "/";
  return p;
}
export function loadBootstrap(): BootstrapConfig {
  const cfg = readConfigJson();

  const dataDir = path.resolve(cfg.dataDir || path.join(process.cwd(), "data"));
  const port = cfg.port ?? 8787;
  const dbPath = path.resolve(cfg.dbPath || path.join(dataDir, "gateway.db"));
  const webDistDir = path.resolve(
    cfg.webDistDir || path.join(__dirname, "..", "web", "dist"),
  );
  let webBasePath = normalizeBasePath(cfg.webBasePath);
  // A base under an API surface would shadow it (express matches in registration
  // order, but the SPA fallback would then swallow unknown API paths).
  if (webBasePath !== "/" && /^\/(api|v1|health)(\/|$)/.test(webBasePath)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[gateway] webBasePath "${webBasePath}" collides with an API surface; using "/"`,
    );
    webBasePath = "/";
  }
  const sessionTtlMs = (cfg.sessionTtlHours ?? 24 * 7) * 60 * 60 * 1000;
  const adminPassword = cfg.adminPassword || null;
  const corsOrigin = cfg.corsOrigin || null;

  return {
    port,
    dataDir,
    dbPath,
    webDistDir,
    webBasePath,
    sessionTtlMs,
    adminPassword,
    configPath: fs.existsSync(CONFIG_FILE) ? CONFIG_FILE : null,
    corsOrigin,
  };
}

// SHA-256 hex digest. Used for admin password hashing and API-key lookup keys.
export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Constant-time string comparison to avoid timing oracle on auth checks.
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still burn some time so length leaks less.
    crypto.timingSafeEqual(bb, bb);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}
