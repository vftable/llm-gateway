// Pure helper functions for ForwardingEngine — no `this`-bound state, so they
// live apart from the class in engine.ts.

import { randomBytes } from "crypto";
import type { IncomingMessage } from "http";
import type { Provider } from "../../types";
import { endpointPathFor, composeUrl, type ResolveUrl } from "../../providers";
import { captureResponse } from "../debug-capture";
import type { Fmt } from "./types";

export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

export const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
export const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export function pathFmt(p: string | undefined | null): Fmt | null {
  if (!p) return null;
  const x = p.split("?")[0];
  if (x.endsWith("/chat/completions")) return "chat";
  if (x.endsWith("/messages")) return "messages";
  if (x.endsWith("/responses")) return "responses";
  return null;
}

// Build the ResolveUrl closure handed to an adapter's build/model methods: it
// composes a full upstream URL from the provider's origin + basePath so an
// adapter never calls `new URL()`. resolve() → this hop's path; resolve(kind) → a
// specific endpoint kind's path; resolve("/literal") → a literal path.
export function makeResolve(provider: Provider, hopPath: string): ResolveUrl {
  return (target) => {
    const path =
      target === undefined
        ? hopPath
        : target === "chat" || target === "messages" || target === "responses"
          ? endpointPathFor(provider, target)
          : target;
    return composeUrl(provider.baseUrl, provider.basePath, path);
  };
}

// Debug capture must never break the response path — swallow any error.
export function safeCaptureResponse(
  parsed: Record<string, unknown>,
): string | undefined {
  try {
    return captureResponse(parsed);
  } catch {
    return undefined;
  }
}

// Short correlation id for a request's transform trace (8 hex chars).
export function shortId(): string {
  return randomBytes(4).toString("hex");
}

// --- header helpers --------------------------------------------------------

export function isEventStream(headers: IncomingMessage["headers"]): boolean {
  return String(headers?.["content-type"] || "")
    .toLowerCase()
    .includes("text/event-stream");
}
export function isJson(headers: IncomingMessage["headers"]): boolean {
  if (
    String(headers?.["content-type"] || "")
      .toLowerCase()
      .includes("application/json")
  ) {
    const enc = String(headers?.["content-encoding"] || "").toLowerCase();
    return !enc || enc === "identity";
  }
  return false;
}

export function filteredHeaders(
  raw: IncomingMessage["headers"] | undefined,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v as string | string[];
  }
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
