// http-proxy-middleware wrapper that:
//   - swaps the client-visible model id for the upstream one in the request body
//   - logs upstream non-2xx responses with the body we sent
//   - buffers non-streaming JSON to convert <thinking> blocks and/or translate
//     a chat/completions response back to Responses shape when bridging
// Everything else (SSE streams, errors, other endpoints) is piped untouched.

import type { ClientRequest, IncomingMessage } from "http";
import type { Request, Response } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import type { GatewayConfig } from "./config";
import type { Logger } from "./logger";
import type { ModelRegistry, ResolvedModel } from "./models";
import { ThinkingConverter } from "./thinking";
import { ResponsesBridge } from "./responses-bridge";
import { stripInvisible } from "./utils";
import { SseThinkingTransform } from "./streaming-thinking";
import { AnthropicThinkingTransform } from "./streaming-anthropic";
import { StreamingResponsesBridgeTransform } from "./responses-bridge";
import { SsePingKeepAlive } from "./sse-ping";

// Max chars of the upstream request body to log on a non-2xx response.
// Large enough to show model + structure, small enough to keep logs readable.
const LOG_BODY_LIMIT = 2000;

// Hard cap on how much response body we buffer for thinking conversion.
// LLM answers are usually small, but this keeps a runaway upstream from
// pinning megabytes of memory per in-flight request.
const MAX_BUFFER_BYTES = 64 * 1024 * 1024; // 64 MB

// Hop-by-hop headers that must not be forwarded from upstream to client.
// RFC 7230 §6.1; copied here so we don't mutate the real headers object.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

export type ConvertKind = "chat" | "responses" | "bridge" | "anthropic";
export type StreamKind = "chat" | "anthropic" | "bridge";

// Per-request fields the gateway stashes on `req` to thread state between the
// guard middleware, the bridge middleware, and the proxy handlers.
// We don't redeclare `body` here — Express's Request already has it as `any`.
export interface GatewayRequest extends Request {
  __gatewayResolved?: ResolvedModel;
  __gatewayResolvedFrom?: string;
  __gatewayResolvedTo?: string;
  __gatewayUpstreamBody?: string;
  __gatewayRewritePath?: string;
  __gatewayResponsesBridge?: boolean;
  __gatewayStreamBridge?: boolean;
  __gatewayConvertKind?: ConvertKind;
  __gatewayStreamKind?: StreamKind;
}

interface GatewayResponseBody {
  model?: string;
  stream?: boolean;
}

function filteredHeaders(
  raw: IncomingMessage["headers"] | undefined,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

export class GatewayProxy {
  constructor(
    private readonly config: GatewayConfig,
    private readonly logger: Logger,
    private readonly models: ModelRegistry,
    private readonly thinking: ThinkingConverter,
    private readonly bridge: ResponsesBridge,
  ) {}

  createMiddleware() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts: any = {
      // Read target dynamically so upstream can be changed (e.g. in tests)
      target: this.config.upstream,
      changeOrigin: true,
      secure: this.config.upstreamTlsVerify,
      ws: false,
      followRedirects: false,
      // Restore the mount prefix Express stripped. We mount this proxy at
      // /v1 (app.use('/v1', proxy)), so by default http-proxy-middleware
      // would forward /messages instead of /v1/messages — which makes the
      // upstream 404. req.baseUrl is '/v1' inside this middleware.
      // The /v1/responses bridge sets req.__gatewayRewritePath to reroute a
      // request to a different upstream path (e.g. '/chat/completions').
      pathRewrite: (path: string, req: GatewayRequest) => {
        const p = (req && req.__gatewayRewritePath) || path;
        return (req.baseUrl || "") + p;
      },
      router: () => this.config.upstream,
      // No timeouts — LLM streams can be very long-lived.
      timeout: 0,
      proxyTimeout: 0,
      // We self-handle so we can buffer + rewrite non-streaming JSON to
      // convert <thinking> blocks. Everything we DON'T want to rewrite is
      // piped straight through in the proxyRes handler below.
      selfHandleResponse: true,
      on: {
        proxyReq: this.prepareProxyReq.bind(this),
        proxyRes: this.handleProxyRes.bind(this),
        error: this.handleProxyError.bind(this),
      },
    };
    return createProxyMiddleware(opts);
  }

  // Re-serialize the (already JSON-parsed) request body onto the upstream
  // request, swapping the client-visible model id for the upstream one.
  //
  // IMPORTANT: every proxyReq.setHeader() MUST run BEFORE the first
  // proxyReq.write(). Calling write() flushes the request headers, and any
  // later setHeader() throws ERR_HTTP_HEADERS_SENT — which was the previous
  // crash when `upstreamApiKey` was set on requests with a body.
  private prepareProxyReq(proxyReq: ClientRequest, req: GatewayRequest): void {
    // 1) Auth headers — setHeader, no write yet.
    if (this.config.upstreamApiKey) {
      // Most OpenAI-compatible routers accept Bearer.
      proxyReq.setHeader(
        "Authorization",
        `Bearer ${this.config.upstreamApiKey}`,
      );
      // Anthropic-compatible upstreams also accept x-api-key. Harmless.
      proxyReq.setHeader("x-api-key", this.config.upstreamApiKey);
    }

    // 2) Rewrite `model` in the JSON body, then write it. The write flushes
    //    headers, so this must come last.
    if (!req.body || typeof req.body !== "object") return;

    const body = (
      Array.isArray(req.body) ? [...req.body] : { ...req.body }
    ) as {
      model?: string;
    } & Record<string, unknown>;

    if (typeof body.model === "string") {
      const original = body.model;
      // Reuse the guard's resolution if available (it ran first); only
      // re-resolve if the guard skipped (e.g. body looked different).
      const resolved =
        req.__gatewayResolved || this.models.resolveUpstream(original);
      if (resolved.upstream) {
        body.model = resolved.upstream;
        req.__gatewayResolvedFrom = original;
        req.__gatewayResolvedTo = resolved.upstream;
        if (resolved.upstream !== original) {
          this.logger.info("resolve", {
            from: original,
            to: resolved.upstream,
          });
        }
      }
    }

    const serialized = JSON.stringify(body);
    // Stash a BOUNDED copy for the proxyRes handler to log on non-2xx.
    // Keeping the full body would pin potentially-megabytes of memory per
    // in-flight request for no benefit (we truncate for logging anyway).
    req.__gatewayUpstreamBody =
      serialized.length > LOG_BODY_LIMIT
        ? serialized.slice(0, LOG_BODY_LIMIT) +
          `...(+${serialized.length - LOG_BODY_LIMIT}b)`
        : serialized;
    proxyReq.setHeader("Content-Length", Buffer.byteLength(serialized));
    proxyReq.setHeader("Content-Type", "application/json");
    proxyReq.removeHeader("transfer-encoding");
    if (serialized.length) proxyReq.write(serialized);
  }

  private handleProxyRes(
    proxyRes: IncomingMessage,
    req: GatewayRequest,
    res: Response,
  ): void {
    // Surface upstream non-2xx responses clearly. Without this, a 404 from
    // 9router (e.g. unknown upstream model id) is indistinguishable from a
    // 404 the gateway itself rejected pre-proxy. We also log the exact body
    // we sent so the upstream-side cause is debuggable.
    const status = proxyRes && proxyRes.statusCode;
    const isErrStatus = !!(status && (status < 200 || status >= 400));
    if (isErrStatus) {
      const body = (req && req.__gatewayUpstreamBody) || "";
      const trunc =
        body.length > LOG_BODY_LIMIT
          ? body.slice(0, LOG_BODY_LIMIT) +
            `...(+${body.length - LOG_BODY_LIMIT}b)`
          : body;

      this.logger.warn("upstream_non_2xx", {
        status,
        method: req.method,
        path: req.originalUrl || req.url,
        upstream: this.config.upstream,
        clientModel: (req && req.__gatewayResolvedFrom) || null,
        upstreamModel: (req && req.__gatewayResolvedTo) || null,
        body: trunc || null,
      });
    }

    // Decide per-response whether to buffer+convert, stream+convert, or
    // stream through untouched.
    if (!isErrStatus) {
      const streamKind = this.shouldStreamConvert(req, proxyRes);
      if (streamKind) {
        req.__gatewayStreamKind = streamKind;
        this.streamConvert(proxyRes, req, res);
        return;
      }
    }
    {
      const kind = !isErrStatus ? this.convertKind(req, proxyRes) : null;
      if (kind) {
        req.__gatewayConvertKind = kind;
        this.convertResponse(proxyRes, req, res);
      } else {
        this.pipeThrough(proxyRes, res);
      }
    }
  }

  private handleProxyError(
    err: Error & { code?: string },
    req: GatewayRequest,
    res: Response,
  ): void {
    this.logger.error("upstream_error", {
      path: req && (req.originalUrl || req.url),
      clientModel: (req && req.__gatewayResolvedFrom) || null,
      upstreamModel: (req && req.__gatewayResolvedTo) || null,
      err:
        err && err.code
          ? `${err.code}: ${err.message}`
          : String((err && err.message) || err),
    });
    if (!res) return;
    if (res.headersSent) {
      // Mid-stream error: can't send a clean JSON error without corrupting
      // the in-flight response. End gracefully so the client sees a clean
      // stream termination rather than a TCP reset.
      try {
        if (!res.writableEnded) res.end();
      } catch (_) {
        /* noop */
      }
      return;
    }
    res.status(502).json({
      error: {
        type: "upstream_error",
        message: String((err && err.message) || err),
        source: "gateway",
        upstream: this.config.upstream,
        clientModel: (req && req.__gatewayResolvedFrom) || null,
        upstreamModel: (req && req.__gatewayResolvedTo) || null,
      },
    });
  }

  // Decide whether — and how — to buffer + convert this upstream JSON response.
  // Returns one of:
  //   'chat'     — /v1/chat/completions response, run <thinking> conversion
  //   'responses'— /v1/responses response (native upstream), run <thinking> conversion
  //   'bridge'   — bridged /v1/responses request: upstream returned chat/completions
  //                JSON; run <thinking> conversion, then translate to Responses shape
  //   null       — pass through untouched
  // Conditions shared by all: POST with parsed body, stream !== true, 2xx JSON,
  // not compressed.
  private convertKind(
    req: GatewayRequest,
    proxyRes: IncomingMessage,
  ): ConvertKind | null {
    if (!req || req.method !== "POST") return null;
    const body = req.body as GatewayResponseBody | undefined;
    if (!body || typeof body !== "object") return null;
    if (body.stream === true) return null;

    const status = proxyRes && proxyRes.statusCode;
    if (!status || status < 200 || status >= 300) return null;

    const headers = (proxyRes && proxyRes.headers) || {};
    const ct = String(headers["content-type"] || "").toLowerCase();
    if (!ct.includes("application/json")) return null;

    // Compressed bodies would need decoding before JSON.parse; skip and let
    // them pass through untouched (rare for LLM JSON responses anyway).
    const enc = String(headers["content-encoding"] || "").toLowerCase();
    if (enc && enc !== "identity") return null;

    // A bridged /v1/responses request got sent to upstream as chat/completions,
    // so the response is chat-shaped and needs translating back.
    if (req.__gatewayResponsesBridge) return "bridge";

    const path = String(req.originalUrl || req.url || "").split("?")[0];
    if (path.endsWith("/chat/completions")) return "chat";
    if (path.endsWith("/responses")) return "responses";
    if (path.endsWith("/messages")) return "anthropic";
    return null;
  }

  // Should this SSE response be run through a streaming <thinking> parser?
  // Returns the kind of transform to apply, or null to pipe through untouched.
  //   'chat'      — /v1/chat/completions (OpenAI SSE: rewrite delta.content
  //                 into delta.reasoning_content + delta.reasoning_details)
  //   'anthropic' — /v1/messages (Anthropic SSE: split inline <thinking> out
  //                 of text_delta events into proper thinking content blocks)
  //   'bridge'    — /v1/responses bridged to /v1/chat/completions: convert
  //                 Chat SSE chunks back to Responses format in real-time
  // All require `stream: true`, 2xx status, and text/event-stream content.
  private shouldStreamConvert(
    req: GatewayRequest,
    proxyRes: IncomingMessage,
  ): StreamKind | null {
    if (!req || req.method !== "POST") return null;
    const body = req.body as GatewayResponseBody | undefined;
    if (!body || body.stream !== true) return null;

    const status = proxyRes && proxyRes.statusCode;
    if (!status || status < 200 || status >= 300) return null;

    const headers = (proxyRes && proxyRes.headers) || {};
    const ct = String(headers["content-type"] || "").toLowerCase();
    if (!ct.includes("text/event-stream")) return null;

    // Streaming bridge: /v1/responses -> /v1/chat/completions
    if (req.__gatewayResponsesBridge && req.__gatewayStreamBridge)
      return "bridge" as StreamKind;

    const path = String(req.originalUrl || req.url || "").split("?")[0];
    if (path.endsWith("/chat/completions")) return "chat";
    if (path.endsWith("/messages")) return "anthropic";
    return null;
  }

  // Pipe the upstream SSE stream through the appropriate transform on its way
  // to the client. Content-Length must be stripped — we're rewriting bytes,
  // so any value the upstream sent would be wrong.
  //
  // A SsePingKeepAlive transform is added after the content transform to
  // prevent Cloudflare/NGINX idle timeouts during long thinking periods.
  private streamConvert(
    proxyRes: IncomingMessage,
    req: GatewayRequest,
    res: Response,
  ): void {
    const headers = filteredHeaders(proxyRes.headers);
    delete headers["content-length"];
    delete headers["Content-Length"];
    // Bridge uses Responses SSE format, not Chat
    if (req.__gatewayStreamKind === "bridge") {
      headers["content-type"] = "text/event-stream";
    }

    let transform: NodeJS.ReadWriteStream;
    if (req.__gatewayStreamKind === "anthropic") {
      transform = new AnthropicThinkingTransform();
    } else if (req.__gatewayStreamKind === "bridge") {
      transform = new StreamingResponsesBridgeTransform();
    } else {
      transform = new SseThinkingTransform();
    }

    // Ping keep-alive to prevent proxy timeouts during long thinking periods.
    // Sends SSE comment lines (`: ping\n\n`) periodically when idle.
    const pingInterval = this.config.ssePingInterval ?? 30_000;
    const ping =
      pingInterval > 0
        ? new SsePingKeepAlive({ interval: pingInterval })
        : null;

    // Prevent unhandled errors from crashing the process. If the client
    // disconnects, res emits error — swallow it so the upstream side can
    // clean up via the 'close' event instead.
    // IMPORTANT: register BEFORE writeHead to avoid a race where the client
    // disconnects between writeHead and the handler registration.
    res.on("error", (err: Error) => {
      this.logger.warn("client_res_error", {
        kind: req.__gatewayStreamKind,
        err: err.message ? err.message : String(err),
      });
    });

    if (!res.headersSent) {
      res.writeHead(proxyRes.statusCode || 200, headers);
    }

    // Upstream read error — log and end gracefully so the client sees a
    // clean stream termination (SSE [DONE] or end-of-stream) rather than
    // a TCP reset.
    proxyRes.on("error", (err: Error) => {
      this.logger.warn("stream_read_error", {
        kind: req.__gatewayStreamKind,
        err: err.message ? err.message : String(err),
      });
      try {
        if (!res.writableEnded) res.end();
      } catch (_) {
        /* noop */
      }
    });

    // Errors in the transform chain (thinking parser, ping). Log and
    // terminate gracefully rather than crashing.
    transform.on("error", (err: Error) => {
      this.logger.warn("stream_transform_error", {
        kind: req.__gatewayStreamKind,
        err: err.message ? err.message : String(err),
      });
      try {
        if (!res.writableEnded) res.end();
      } catch (_) {
        /* noop */
      }
    });

    if (ping) {
      ping.on("error", (err: Error) => {
        this.logger.warn("stream_ping_error", {
          err: err.message ? err.message : String(err),
        });
      });
      proxyRes.pipe(transform).pipe(ping).pipe(res);
    } else {
      proxyRes.pipe(transform).pipe(res);
    }
  }

  // Stream the upstream response straight to the client, byte-for-byte.
  // Used for SSE, errors, and any JSON we're not rewriting.
  // For SSE streams, adds a ping keep-alive to prevent proxy timeouts.
  private pipeThrough(proxyRes: IncomingMessage, res: Response): void {
    const headers = filteredHeaders(proxyRes.headers);

    // Prevent unhandled errors from crashing the process.
    // IMPORTANT: register BEFORE writeHead to avoid a race.
    res.on("error", (err: Error) => {
      this.logger.warn("client_res_error", {
        err: err.message ? err.message : String(err),
      });
    });

    if (!res.headersSent) {
      res.writeHead(proxyRes.statusCode || 200, headers);
    }

    // Upstream read error — end gracefully.
    proxyRes.on("error", (err: Error) => {
      this.logger.warn("pipe_read_error", {
        err: err.message ? err.message : String(err),
      });
      try {
        if (!res.writableEnded) res.end();
      } catch (_) {
        /* noop */
      }
    });

    // Check if this is an SSE stream by content-type
    const ct = String(headers["content-type"] || "").toLowerCase();
    if (ct.includes("text/event-stream")) {
      // SSE stream: add ping keep-alive to prevent idle timeouts
      const pingInterval = this.config.ssePingInterval ?? 30_000;
      if (pingInterval > 0) {
        const ping = new SsePingKeepAlive({ interval: pingInterval });
        ping.on("error", (err: Error) => {
          this.logger.warn("pipe_ping_error", {
            err: err.message ? err.message : String(err),
          });
        });
        proxyRes.pipe(ping).pipe(res);
      } else {
        proxyRes.pipe(res);
      }
    } else {
      proxyRes.pipe(res);
    }
  }

  // Buffer a JSON response, run the appropriate conversion, and send the result.
  // `req.__gatewayConvertKind` (set by convertKind) selects which: 'chat' and
  // 'responses' run the <thinking> extractor; 'bridge' additionally translates a
  // chat/completions body into the Responses shape. Falls back to the original
  // bytes on any parse/transform error, and also when a thinking conversion
  // found no <thinking> blocks (so unchanged responses reach the client verbatim,
  // not re-serialized).
  private convertResponse(
    proxyRes: IncomingMessage,
    req: GatewayRequest,
    res: Response,
  ): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    let errored = false;

    // Prevent unhandled errors from crashing the process.
    res.on("error", (err: Error) => {
      this.logger.warn("client_res_error", {
        path: req.originalUrl || req.url,
        err: err.message ? err.message : String(err),
      });
    });

    proxyRes.on("data", (chunk: Buffer) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > MAX_BUFFER_BYTES) {
        tooBig = true;
        this.logger.warn("thinking_buffer_overflow", {
          path: req.originalUrl || req.url,
          bytes: size,
        });
        // We've already consumed partial data we can't unsend, so the best
        // we can do for the client is surface a clean error.
        if (!res.headersSent) {
          res.status(502).json({
            error: {
              type: "upstream_error",
              message: "Upstream response too large to convert",
              source: "gateway",
            },
          });
        } else {
          try {
            if (!res.writableEnded) res.end();
          } catch (_) {
            /* noop */
          }
        }
        try {
          proxyRes.destroy();
        } catch (_) {
          /* noop */
        }
        return;
      }
      chunks.push(chunk);
    });

    proxyRes.on("end", () => {
      if (tooBig || errored || res.headersSent) return;
      const original = Buffer.concat(chunks);
      const stripped = Buffer.from(
        stripInvisible(original.toString("utf8")),
        "utf8",
      );

      let parsed: unknown;
      try {
        parsed = JSON.parse(stripped.toString("utf8"));
      } catch (err) {
        this.logger.warn("thinking_parse_failed", {
          path: req.originalUrl || req.url,
          err: (err as Error).message,
        });
        this.sendRaw(proxyRes, res, stripped);
        return;
      }

      const kind = req.__gatewayConvertKind;

      // Pick the transform for this kind. All of them return the mutated body
      // when something changed, or null to mean "no rewrite needed".
      let transformed: unknown = null;
      try {
        if (kind === "bridge") {
          // The upstream reply is chat/completions JSON. Run <thinking>
          // conversion first (it may set reasoning_details on the message),
          // then translate the whole thing to the Responses shape.
          this.thinking.applyToChatCompletion(
            parsed as Parameters<typeof this.thinking.applyToChatCompletion>[0],
          );
          transformed = this.bridge.responseFromChatCompletions(
            parsed as Parameters<
              typeof this.bridge.responseFromChatCompletions
            >[0],
          );
          // responseFromChatCompletions always returns a body for a valid
          // chat completion — but guard anyway.
          if (!transformed) {
            this.sendRaw(proxyRes, res, stripped);
            return;
          }
        } else if (kind === "responses") {
          transformed = this.thinking.applyToResponse(
            parsed as Parameters<typeof this.thinking.applyToResponse>[0],
          );
        } else if (kind === "anthropic") {
          transformed = this.thinking.applyToAnthropicMessage(
            parsed as Parameters<
              typeof this.thinking.applyToAnthropicMessage
            >[0],
          );
        } else {
          transformed = this.thinking.applyToChatCompletion(
            parsed as Parameters<typeof this.thinking.applyToChatCompletion>[0],
          );
        }
      } catch (err) {
        this.logger.warn("thinking_transform_error", {
          path: req.originalUrl || req.url,
          kind,
          err: err && (err as Error).stack ? (err as Error).stack : String(err),
        });
        this.sendRaw(proxyRes, res, stripped);
        return;
      }

      // For chat/responses: if no <thinking> blocks were found, pass the
      // original bytes through so we don't perturb the response with a
      // re-serialization. The bridge kind always produces a fresh body.
      if (!transformed && kind !== "bridge") {
        this.sendRaw(proxyRes, res, stripped);
        return;
      }

      const out = Buffer.from(JSON.stringify(transformed), "utf8");
      const headers = filteredHeaders(proxyRes.headers);
      headers["content-length"] = String(out.length);
      if (!res.headersSent) {
        res.writeHead(proxyRes.statusCode || 200, headers);
      }
      res.end(out);
    });

    proxyRes.on("error", (err: Error) => {
      this.logger.warn("thinking_read_error", {
        path: req && (req.originalUrl || req.url),
        err: err && err.message ? err.message : String(err),
      });
      errored = true;
      if (!res.headersSent) {
        res.status(502).json({
          error: {
            type: "upstream_error",
            message: "Failed reading upstream response",
            source: "gateway",
          },
        });
      } else {
        try {
          if (!res.writableEnded) res.end();
        } catch (_) {
          /* noop */
        }
      }
    });
  }

  private sendRaw(proxyRes: IncomingMessage, res: Response, buf: Buffer): void {
    if (res.headersSent) {
      try {
        if (!res.writableEnded) res.end();
      } catch (_) { /* noop */ }
      return;
    }
    res.writeHead(
      proxyRes.statusCode || 200,
      filteredHeaders(proxyRes.headers),
    );
    res.end(buf);
  }
}
