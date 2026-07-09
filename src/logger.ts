// Tiny ANSI logger with column-aligned, colorized request/event lines.
// Auto-disables color when stdout isn't a TTY (e.g. piped to a file).

import type { Request, Response } from "express";

type Meta = Record<string, unknown>;

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

  private write(level: string, message: string, meta?: Meta): void {
    const line = `${ts()} ${LEVELS[level] || pad(level, 5)} ${message}`;
    process.stdout.write(meta ? `${line}${fmtMeta(meta)}\n` : `${line}\n`);
  }
}
