// Minimal buffered HTTP JSON POST/GET helper. Used by the web-tool loop to
// call Firecrawl and (via the engine) to run non-streaming upstream turns.
// Deliberately tiny and dependency-free; it buffers the whole response, so it
// is ONLY for non-streaming JSON exchanges (never the client-facing stream).

import http from "http";
import https from "https";
import { URL } from "url";

export interface JsonResponse {
  status: number;
  text: string;
}

export interface PostOpts {
  url: string;
  method?: "POST" | "GET";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  tlsVerify?: boolean;
  /** Hard cap on buffered bytes (defence against a runaway upstream). */
  maxBytes?: number;
  /** Optional outbound proxy agent (SOCKS5/HTTP); omit for a direct connection. */
  agent?: http.Agent | https.Agent;
}

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export function requestJson(opts: PostOpts): Promise<JsonResponse> {
  const url = new URL(opts.url);
  const transport = url.protocol === "https:" ? https : http;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const method = opts.method ?? "POST";

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        method,
        path: `${url.pathname}${url.search}`,
        headers: {
          accept: "application/json",
          ...(opts.body != null
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(opts.body)),
              }
            : {}),
          ...(opts.headers ?? {}),
        },
        rejectUnauthorized: opts.tlsVerify !== false,
        ...(opts.agent ? { agent: opts.agent } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let aborted = false;
        res.on("data", (c: Buffer) => {
          if (aborted) return;
          size += c.length;
          if (size > maxBytes) {
            aborted = true;
            res.destroy();
            reject(new Error("response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          if (aborted) return;
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );

    const timer = setTimeout(() => {
      req.destroy(new Error(`request timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === "function")
      (timer as { unref: () => void }).unref();

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.on("close", () => clearTimeout(timer));

    if (opts.body != null) req.write(opts.body);
    req.end();
  });
}
