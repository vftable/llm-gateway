// Tiny ANSI logger with column-aligned, colorized request/event lines.
// Auto-disables color when stdout isn't a TTY (e.g. piped to a file).

import type { Request, Response } from "express";

type Meta = Record<string, unknown>;

type HeaderValue = string | string[] | number | undefined;

export interface UpstreamErrorInfo {
  status: number;
  provider: string;
  upstreamModel: string;
  path?: string | null;
  keyMask?: string | null;
  headers: Record<string, HeaderValue>;
  body: string;
  category?: string;
  details?: Record<string, unknown>;
}

const isTTY = process.stdout.isTTY;

const C = isTTY
  ? {
      reset: "\x1b[0m",
      dim: "\x1b[2m",
      bold: "\x1b[1m",
      red: "\x1b[31m",
      green: "\x1b[32m",
      yellow: "\x1b[33m",
      blue: "\x1b[34m",
      magenta: "\x1b[35m",
      cyan: "\x1b[36m",
      gray: "\x1b[90m",
    }
  : ({} as Record<string, string>);

const c = (color: keyof typeof C | string, s: string): string =>
  C[color] ? C[color] + s + C.reset : s;

function ts(): string {
  const d = new Date();
  const p = (n: number, l = 2): string => String(n).padStart(l, "0");
  return c(
    "gray",
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`,
  );
}

const pad = (s: string, n: number): string =>
  s.length >= n ? s : s + " ".repeat(n - s.length);
const padL = (s: string, n: number): string =>
  s.length >= n ? s : " ".repeat(n - s.length) + s;

function fmtMs(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function statusColor(s: number | undefined): string {
  if (s === undefined) return c("gray", padL("---", 3));
  if (s >= 500) return c("red", padL(String(s), 3));
  if (s >= 400) return c("yellow", padL(String(s), 3));
  if (s >= 300) return c("cyan", padL(String(s), 3));
  if (s >= 200) return c("green", padL(String(s), 3));
  return c("gray", padL(String(s), 3));
}

const LEVELS: Record<string, string> = {
  INFO: c("green", pad("INFO", 5)),
  WARN: c("yellow", pad("WARN", 5)),
  ERROR: c("red", pad("ERROR", 5)),
  DEBUG: c("gray", pad("DEBUG", 5)),
  XFORM: c("magenta", pad("XFORM", 5)),
};

// Direction glyphs for transform lines (request / response / stream).
const XFORM_DIR: Record<string, string> = {
  req: c("cyan", "req  "),
  resp: c("green", "resp "),
  stream: c("blue", "strm "),
};

function fmtMeta(meta?: Meta): string {
  if (!meta) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    const val = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${c("dim", k)}=${val}`);
  }
  return " " + parts.join(" ");
}

function methodColor(m: string): string {
  switch (m) {
    case "GET":
      return c("green", pad(m, 7));
    case "POST":
      return c("cyan", pad(m, 7));
    case "PUT":
      return c("yellow", pad(m, 7));
    case "PATCH":
      return c("yellow", pad(m, 7));
    case "DELETE":
      return c("red", pad(m, 7));
    case "OPTIONS":
      return c("gray", pad(m, 7));
    case "HEAD":
      return c("gray", pad(m, 7));
    default:
      return c("magenta", pad(m, 7));
  }
}

function sizeStr(bytes: number | undefined): string {
  if (bytes === undefined || bytes === 0) return c("gray", padL("-", 8));
  if (bytes < 1024) return c("dim", padL(`${bytes}B`, 8));
  if (bytes < 1024 * 1024)
    return c("dim", padL(`${(bytes / 1024).toFixed(1)}kB`, 8));
  return c("dim", padL(`${(bytes / (1024 * 1024)).toFixed(1)}MB`, 8));
}

function routeTag(url: string): string {
  if (url.startsWith("/v1")) return c("magenta", pad("gw", 4));
  if (url.startsWith("/api")) return c("blue", pad("api", 4));
  if (url === "/health") return c("green", pad("sys", 4));
  return c("gray", pad("web", 4));
}

const SENSITIVE_HEADER_RE =
  /(?:^|[-_])(?:authorization|auth|api[-_]?key|token|secret|credential|cookie)(?:$|[-_])/i;

export function isSensitiveHeaderName(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "authorization" ||
    normalized === "proxy-authorization" ||
    normalized === "cookie" ||
    normalized === "set-cookie" ||
    SENSITIVE_HEADER_RE.test(normalized)
  );
}

function prettyBody(
  body: string,
  headers: Record<string, HeaderValue>,
): string {
  const contentType = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "content-type",
  )?.[1];
  const contentTypeText = Array.isArray(contentType)
    ? contentType.join(", ")
    : String(contentType ?? "");
  const trimmed = body.trim();
  if (!trimmed) return "<empty>";
  const looksJson =
    /(?:^|[+/.-])json(?:$|[; +.-])/i.test(contentTypeText) ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[");
  if (looksJson) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      // A provider can label malformed error text as JSON; preserve it verbatim.
    }
  }
  return body;
}

function indentBlock(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `    ${line}`)
    .join("\n");
}

function colorForStatus(status: number): keyof typeof C {
  if (status >= 500) return "red";
  if (status >= 400) return "yellow";
  if (status >= 300) return "cyan";
  return "gray";
}

export function formatUpstreamError(
  info: UpstreamErrorInfo,
  useColor = false,
): string {
  const color = (name: keyof typeof C, text: string) =>
    useColor
      ? `\x1b[${name === "red" ? 31 : name === "yellow" ? 33 : name === "cyan" ? 36 : 90}m${text}\x1b[0m`
      : text;
  const status = color(colorForStatus(info.status), String(info.status));
  const category = info.category ? ` · ${info.category}` : "";
  const context = [
    `provider=${info.provider}`,
    `model=${info.upstreamModel}`,
    info.path ? `path=${info.path}` : null,
    info.keyMask ? `key=${info.keyMask}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const headers = Object.entries(info.headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => {
      const rendered = isSensitiveHeaderName(name)
        ? "<redacted>"
        : Array.isArray(value)
          ? value.join(", ")
          : String(value ?? "");
      return `    ${name.toLowerCase()}: ${rendered}`;
    });
  const details = Object.entries(info.details ?? {}).map(
    ([name, value]) =>
      `    ${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
  const border = color(colorForStatus(info.status), "─".repeat(72));
  return [
    border,
    `${color(colorForStatus(info.status), "UPSTREAM NON-2XX")} ${status}${category}`,
    `  ${context}`,
    ...(details.length ? ["  Details", ...details] : []),
    "  Response headers",
    ...(headers.length ? headers : ["    <none>"]),
    "  Response body",
    indentBlock(prettyBody(info.body, info.headers)),
    border,
  ].join("\n");
}

export class Logger {
  info(message: string, meta?: Meta): void {
    this.write("INFO", message, meta);
  }

  warn(message: string, meta?: Meta): void {
    this.write("WARN", message, meta);
  }

  error(message: string, meta?: Meta): void {
    this.write("ERROR", message, meta);
  }

  debug(message: string, meta?: Meta): void {
    this.write("DEBUG", message, meta);
  }

  upstreamError(info: UpstreamErrorInfo): void {
    process.stdout.write(`${formatUpstreamError(info, !!isTTY)}\n`);
  }

  // One line per transformation applied to a request/response. `dir` is
  // "req" | "resp" | "stream"; `name` is the transform's registered name
  // (e.g. "format:chat->messages"). Emitted only when debug logging is on
  // (the engine gates the call), so this is free when disabled.
  transform(dir: string, name: string, meta?: Meta): void {
    const arrow = c("dim", "▸");
    const d = XFORM_DIR[dir] || pad(dir, 5);
    this.write("XFORM", `${arrow} ${d} ${name}`, meta);
  }

  request(
    req: Request,
    res: Response,
    rtMs: number,
    note?: string | null,
    body?: { model?: string },
  ): void {
    const method = c("magenta", pad(req.method || "----", 5));
    const url = c("blue", pad(req.originalUrl || req.url || "", 26));
    const modelField =
      body && typeof body.model === "string"
        ? c("cyan", pad(body.model, 20))
        : c("gray", pad("-", 20));
    const status = statusColor(res.statusCode);
    const rt = c("gray", padL(fmtMs(rtMs), 7));
    const noteStr = note ? " " + c("yellow", note) : "";
    process.stdout.write(
      `${ts()} ${method} ${url} ${modelField} ${status} ${rt}${noteStr}\n`,
    );
  }

  httpLog(
    method: string,
    url: string,
    status: number,
    rtMs: number,
    resBytes: number | undefined,
  ): void {
    const m = methodColor(method);
    const tag = routeTag(url);
    const u = c(
      "bold",
      pad(url.length > 50 ? url.slice(0, 47) + "..." : url, 50),
    );
    const st = statusColor(status);
    const rt = c("gray", padL(fmtMs(rtMs), 8));
    const sz = sizeStr(resBytes);
    process.stdout.write(
      `${ts()} ${c("dim", "│")} ${m} ${tag} ${u} ${st} ${rt} ${sz}\n`,
    );
  }

  httpMiddleware(): (req: Request, res: Response, next: () => void) => void {
    return (req, res, next) => {
      const start = process.hrtime.bigint();
      const origWrite = res.write;
      const origEnd = res.end;
      let bytes = 0;

      res.write = function (chunk: unknown, ...args: unknown[]) {
        if (chunk) bytes += Buffer.byteLength(chunk as Buffer | string);
        return (origWrite as Function).apply(res, [chunk, ...args]);
      } as typeof res.write;

      res.end = function (chunk: unknown, ...args: unknown[]) {
        if (chunk) bytes += Buffer.byteLength(chunk as Buffer | string);
        return (origEnd as Function).apply(res, [chunk, ...args]);
      } as typeof res.end;

      res.on("finish", () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        this.httpLog(
          req.method,
          req.originalUrl || req.url,
          res.statusCode,
          ms,
          bytes || undefined,
        );
      });
      next();
    };
  }

  private write(level: string, message: string, meta?: Meta): void {
    const line = `${ts()} ${LEVELS[level] || pad(level, 5)} ${message}`;
    process.stdout.write(meta ? `${line}${fmtMeta(meta)}\n` : `${line}\n`);
  }
}
