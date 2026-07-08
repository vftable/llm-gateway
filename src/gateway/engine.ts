// Multi-provider forwarding engine with wire-format conversion.
//
// For each proxied request the engine walks the resolved model's fallback
// chain (ordered provider links). For each provider it computes a "route":
// which endpoint to hit and whether the gateway must convert between the
// client's wire format (Anthropic Messages / OpenAI Chat / OpenAI Responses)
// and the provider's endpoint format. Providers flagged `nativeConversion`
// accept the client's request as-is (the provider converts internally, e.g.
// LiteLLM/9router); otherwise the gateway translates request + response.
//
// Per provider, it retries up to `retryAttempts`, round-robin rotating the
// provider's API keys between attempts. The first 2xx commits the response.
// On a committed 2xx the thinking/responses/anthropic-openai transforms are
// applied (streaming SSE is piped through transform streams; non-streaming
// JSON is buffered + converted). Every request is logged, and per-key usage
// is reconciled with the upstream-reported actual token count and attributed
// to (key, model, provider) in usage_breakdown.

import http from "http";
import https from "https";
import { URL } from "url";
import { Transform, pipeline as streamPipeline } from "stream";
import type { IncomingMessage } from "http";
import type { Request, Response } from "express";
import type { Database as DB } from "better-sqlite3";
import type { Logger } from "../logger";
import type { ApiKey, Model, Provider } from "../shared/types";
import { ThinkingConverter } from "../thinking";
import { ResponsesBridge } from "../responses-bridge";
import { StreamingResponsesBridgeTransform } from "../responses-bridge";
import { SseThinkingTransform } from "../streaming-thinking";
import { AnthropicThinkingTransform } from "../streaming-anthropic";
import { SsePingKeepAlive } from "../sse-ping";
import { SseUsageObserver } from "./sse-usage";
import { requestJson, type JsonResponse } from "./http-json";
import { detectWebTools } from "./web-tools";
import { runWebToolLoop } from "./web-tool-loop";
import { getWebProvider, DEFAULT_PROVIDER } from "./web-providers";
import { stripInvisible } from "../utils";
import { readResponseUsage } from "../tokens";
import { listProviders } from "../repo/providers";
import { addUsage, subtractUsage, addBreakdown } from "../repo/usage";
import { insertRequestLog } from "../repo/request-logs";
import { getSetting } from "../repo/settings";
import {
  captureRequest,
  captureResponse,
  packResponseSummary,
} from "./debug-capture";
import {
  chatRequestToMessages,
  chatResponseToMessages,
  messagesRequestToChat,
  messagesResponseToChat,
  ChatToMessagesSseTransform,
  MessagesToChatSseTransform,
} from "../anthropic-openai-bridge";

const HOP_BY_HOP = new Set([
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

const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// The three wire formats the gateway understands.
type Fmt = "chat" | "messages" | "responses";

function pathFmt(p: string | undefined | null): Fmt | null {
  if (!p) return null;
  const x = p.split("?")[0];
  if (x.endsWith("/chat/completions")) return "chat";
  if (x.endsWith("/messages")) return "messages";
  if (x.endsWith("/responses")) return "responses";
  return null;
}

// Per-attempt route plan: where to send + how to convert.
interface Route {
  forwardPath: string;
  providerFmt: Fmt;
  convert: boolean;
  reqConvert: ((b: Record<string, unknown>) => Record<string, unknown>) | null;
  respConvert: ((b: Record<string, unknown>) => Record<string, unknown>) | null;
  streamBridge: (() => Transform) | null;
  unsupported?: string;
}

export interface ForwardContext {
  clientPath: string;
  requestBody: Record<string, unknown>;
  resolvedModel: Model | null;
  alias: string;
  apiKey: ApiKey | null;
  inputTokens: number;
  /** Tokens the pipeline optimistically debited from the key's daily counter
   *  (input estimate + reserved max output). Settlement reverses exactly this,
   *  then applies the actual usage — see settleUsage(). */
  reservedTokens: number;
  isStream: boolean;
  client: string | null;
  /** When true, capture distilled request/response payloads for the debug view.
   *  Read once per request from settings.debugLogging. */
  debug: boolean;
  /** Distilled client request JSON, computed once when debug is on. */
  debugRequest?: string | null;
  /** Web-tools config; when enabled, requests carrying the hosted web_search /
   *  web_fetch tools are handled by the gateway's loop against the selected
   *  web provider (see ./web-providers). */
  webTools?: {
    enabled: boolean;
    provider: string; // registry id, e.g. "firecrawl"
    baseUrl: string;
    apiKey: string;
  };
}

interface AttemptResult {
  committed: boolean;
  /** True when a streaming attempt will settle usage + log itself once its
   *  pipeline ends; the caller must not settle/log again. */
  deferred?: boolean;
  status?: number;
  inputTokens?: number;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  /** Distilled response JSON (debug capture) from the buffered path. */
  debugResponse?: string | null;
  reason?: string;
  error?: string | null;
}

// Upstream-reported usage shape (subset of readResponseUsage's return).
interface StreamUsageLike {
  input?: number;
  output?: number;
  cached?: number;
}

export class ForwardingEngine {
  private keyCursor = new Map<string, number>();

  constructor(
    private readonly db: DB,
    private readonly logger: Logger,
    private readonly thinking: ThinkingConverter,
    private readonly bridge: ResponsesBridge,
    private readonly ssePingInterval: number,
  ) {}

  // --- chain + route --------------------------------------------------------

  private buildChain(model: Model | null): Array<{
    provider: Provider;
    upstreamModel: string;
    endpoint: string | null;
  }> {
    if (!model) return [];
    const enabledProviders = new Map(
      listProviders(this.db, false).map((p) => [p.id, p]),
    );
    const chain: Array<{
      provider: Provider;
      upstreamModel: string;
      endpoint: string | null;
    }> = [];
    for (const link of model.providers) {
      if (!link.enabled) continue;
      const provider = enabledProviders.get(link.providerId);
      if (provider && provider.enabled)
        chain.push({
          provider,
          upstreamModel: link.upstreamModel,
          endpoint: link.endpoint ?? null,
        });
    }
    if (chain.length === 0) {
      for (const provider of enabledProviders.values())
        chain.push({ provider, upstreamModel: model.alias, endpoint: null });
    }
    return chain;
  }

  // Resolve the endpoint path for a provider link: explicit link endpoint ->
  // first supported provider endpoint -> format default.
  private resolveEndpoint(provider: Provider, endpoint: string | null): string {
    if (endpoint && pathFmt(endpoint)) return endpoint;
    if (provider.endpoints?.length && pathFmt(provider.endpoints[0]))
      return provider.endpoints[0];
    return provider.format === "anthropic"
      ? "/v1/messages"
      : "/v1/chat/completions";
  }

  // Build the conversion plan for one attempt.
  private buildRoute(
    clientPath: string,
    provider: Provider,
    endpoint: string | null,
  ): Route {
    const clientFmt = pathFmt(clientPath) ?? "chat";
    // nativeConversion: provider accepts the client's format/endpoint directly.
    if (provider.nativeConversion) {
      return {
        forwardPath: clientPath.split("?")[0],
        providerFmt: clientFmt,
        convert: false,
        reqConvert: null,
        respConvert: null,
        streamBridge: null,
      };
    }
    const forwardPath = this.resolveEndpoint(provider, endpoint);
    const providerFmt = pathFmt(forwardPath) ?? "chat";
    const convert = clientFmt !== providerFmt;
    if (!convert) {
      return {
        forwardPath,
        providerFmt,
        convert: false,
        reqConvert: null,
        respConvert: null,
        streamBridge: null,
      };
    }
    const reqConvert = reqConverter(clientFmt, providerFmt);
    const respConvert = respConverter(providerFmt, clientFmt);
    const streamBridge = streamBridgeFactory(providerFmt, clientFmt);
    if (!reqConvert || !respConvert) {
      return {
        forwardPath,
        providerFmt,
        convert: true,
        reqConvert,
        respConvert,
        streamBridge,
        unsupported: `gateway cannot convert ${clientFmt} <-> ${providerFmt} for provider '${provider.id}'`,
      };
    }
    return {
      forwardPath,
      providerFmt,
      convert: true,
      reqConvert,
      respConvert,
      streamBridge,
    };
  }

  // --- forward ---------------------------------------------------------------

  async forward(
    req: Request,
    res: Response,
    ctx: ForwardContext,
  ): Promise<void> {
    const startedAt = Date.now();
    // Distill the client request once, up front, from the already-parsed body
    // (no extra buffering). Captured for every attempt's log row.
    if (ctx.debug) {
      try {
        ctx.debugRequest = captureRequest(ctx.requestBody);
      } catch {
        ctx.debugRequest = null;
      }
    }

    // Firecrawl-backed web tools: if enabled and this Messages request asks for
    // the hosted web_search / web_fetch tools, hand the whole request to the
    // agent loop (which the gateway runs itself) instead of a single proxied
    // turn. Only Messages-format clients (e.g. Claude Code) use these tools;
    // other paths fall through to the normal proxy untouched.
    if (
      ctx.webTools?.enabled &&
      pathFmt(ctx.clientPath) === "messages" &&
      this.hasWebTools(ctx.requestBody)
    ) {
      await this.forwardWebToolLoop(req, res, ctx, startedAt);
      return;
    }

    const chain = this.buildChain(ctx.resolvedModel);
    if (chain.length === 0) {
      this.logger.error("no_providers", { model: ctx.alias });
      this.finish502(res, "No provider is configured for this model.");
      this.recordLog(
        ctx,
        null,
        null,
        502,
        null,
        null,
        null,
        "no providers",
        startedAt,
      );
      return;
    }

    let lastReason = "no attempts";
    let first: {
      provider: Provider;
      upstreamModel: string;
      endpoint: string | null;
    } | null = null;
    for (const entry of chain) {
      if (!first) first = entry;
      const route = this.buildRoute(
        ctx.clientPath,
        entry.provider,
        entry.endpoint,
      );
      if (route.unsupported) {
        lastReason = route.unsupported;
        this.logger.warn("conversion_unsupported", {
          provider: entry.provider.id,
          model: entry.upstreamModel,
          detail: lastReason,
        });
        continue; // try the next provider in the chain
      }
      const attempts = Math.max(1, entry.provider.retryAttempts);
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (res.headersSent || res.writableEnded) return;
        const result = await this.attemptOnce(
          req,
          res,
          ctx,
          entry,
          route,
          startedAt,
        );
        if (result.committed) {
          // A streaming attempt settles + logs itself when its pipeline ends
          // (the real token counts aren't known until then); don't double-log.
          if (!result.deferred) {
            this.settleUsage(ctx, entry.provider, {
              input: result.inputTokens ?? undefined,
              output: result.outputTokens ?? undefined,
            });
            this.recordLog(
              ctx,
              entry.provider,
              entry.upstreamModel,
              result.status ?? null,
              result.inputTokens ?? (ctx.inputTokens || null),
              result.outputTokens ?? null,
              result.cachedTokens ?? null,
              result.error ?? null,
              startedAt,
              result.debugResponse ?? null,
            );
          }
          return;
        }
        lastReason = result.reason || lastReason;
        const more = attempt < attempts;
        this.logger.warn("provider_attempt_failed", {
          provider: entry.provider.id,
          attempt: `${attempt}/${attempts}`,
          model: entry.upstreamModel,
          reason: lastReason,
          failover: more
            ? "retry"
            : entry === chain[chain.length - 1]
              ? "exhausted"
              : "next-provider",
        });
        if (more) await sleep(entry.provider.retryIntervalMs);
      }
    }

    if (!res.headersSent && !res.writableEnded)
      this.finish502(res, `All providers failed (last reason: ${lastReason}).`);
    // No upstream usage to apply — release the reservation so a failed request
    // doesn't permanently inflate the key's daily counter.
    this.settleUsage(ctx, first?.provider ?? null, {});
    this.recordLog(
      ctx,
      first?.provider ?? null,
      first?.upstreamModel ?? null,
      502,
      ctx.inputTokens || null,
      null,
      null,
      lastReason,
      startedAt,
    );
  }

  private finish502(res: Response, message: string): void {
    if (res.headersSent) {
      try {
        if (!res.writableEnded) res.end();
      } catch {
        /* noop */
      }
      return;
    }
    res.status(502).json({
      error: { type: "upstream_error", message, source: "gateway" },
    });
  }

  // --- one attempt ----------------------------------------------------------

  private attemptOnce(
    req: Request,
    res: Response,
    ctx: ForwardContext,
    entry: {
      provider: Provider;
      upstreamModel: string;
      endpoint: string | null;
    },
    route: Route,
    startedAt: number,
  ): Promise<AttemptResult> {
    const { provider, upstreamModel } = entry;

    // Convert the client body into the provider's format, then stamp the
    // upstream model id. Falls back to the original body on conversion error.
    let body: Record<string, unknown>;
    try {
      body = route.reqConvert
        ? route.reqConvert({ ...ctx.requestBody })
        : { ...ctx.requestBody };
    } catch (err) {
      return Promise.resolve({
        committed: false,
        reason: `request conversion failed: ${(err as Error).message}`,
      });
    }
    body.model = upstreamModel;
    const serialized = Buffer.from(JSON.stringify(body), "utf8");

    let upstreamUrl: URL;
    try {
      upstreamUrl = new URL(route.forwardPath, provider.baseUrl);
    } catch {
      return Promise.resolve({
        committed: false,
        reason: `bad provider baseUrl: ${provider.baseUrl}`,
      });
    }
    const key = this.pickKey(provider);
    const headers = this.buildHeaders(req, provider, key, serialized.length);
    const transport = upstreamUrl.protocol === "https:" ? https : http;

    return new Promise((resolvePromise) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let timedOut = false;
      let clientGone = false;

      // If the client disconnects while we're still waiting on upstream
      // headers, abort the upstream request instead of letting it run to its
      // timeout. Listener is removed when this attempt settles so retries
      // don't stack listeners on `res`.
      const onClientClose = () => {
        clientGone = true;
        proxyReq.destroy(new Error("client disconnected"));
      };
      const resolve = (r: AttemptResult) => {
        res.off("close", onClientClose);
        resolvePromise(r);
      };

      const proxyReq = transport.request(
        {
          protocol: upstreamUrl.protocol,
          hostname: upstreamUrl.hostname,
          port:
            upstreamUrl.port || (upstreamUrl.protocol === "https:" ? 443 : 80),
          method: req.method,
          path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
          headers,
          rejectUnauthorized: provider.tlsVerify,
        },
        (upRes) => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          this.handleUpstreamResponse(
            upRes,
            res,
            ctx,
            provider,
            upstreamModel,
            route,
            startedAt,
          ).then(resolve, (err) =>
            resolve({ committed: false, reason: err.message }),
          );
        },
      );

      timer = setTimeout(() => {
        timedOut = true;
        proxyReq.destroy(new Error("upstream request timeout"));
      }, provider.requestTimeoutMs);
      if (typeof (timer as { unref?: () => void }).unref === "function")
        (timer as { unref: () => void }).unref();

      proxyReq.on("error", (err: Error & { code?: string }) => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (clientGone) {
          // Nobody is listening — commit so the chain doesn't retry.
          resolve({
            committed: true,
            status: 499,
            error: "client disconnected",
          });
          return;
        }
        const reason = timedOut
          ? `timeout after ${provider.requestTimeoutMs}ms`
          : err.code
            ? `${err.code}: ${err.message}`
            : err.message;
        this.logger.warn("upstream_error", {
          provider: provider.id,
          model: upstreamModel,
          err: reason,
        });
        resolve({ committed: false, reason });
      });

      res.once("close", onClientClose);
      proxyReq.write(serialized);
      proxyReq.end();
    });
  }

  private async handleUpstreamResponse(
    upRes: IncomingMessage,
    res: Response,
    ctx: ForwardContext,
    provider: Provider,
    upstreamModel: string,
    route: Route,
    startedAt: number,
  ): Promise<AttemptResult> {
    const status = upRes.statusCode || 502;
    const headers = upRes.headers || {};

    if (RETRY_STATUS.has(status)) {
      upRes.resume();
      return { committed: false, status, reason: `status ${status}` };
    }

    if (status < 200 || status >= 300) {
      const chunks: Buffer[] = [];
      for await (const c of upRes) chunks.push(c as Buffer);
      const errBody = Buffer.concat(chunks);
      this.logger.warn("upstream_non_2xx", {
        status,
        provider: provider.id,
        upstreamModel,
        path: ctx.clientPath,
        body: errBody.toString("utf8").slice(0, 2000),
      });
      if (!res.headersSent) {
        res.writeHead(status, filteredHeaders(headers));
        res.end(errBody);
      }
      return { committed: true, status, error: `upstream ${status}` };
    }

    // 2xx — streaming vs buffered. Conversion decisions use the PROVIDER format
    // (the shape upstream returns), then we bridge to the client format.
    if (ctx.isStream && isEventStream(headers)) {
      // Streaming settles itself: the real token counts only arrive in the
      // stream's final events, so an SSE observer captures them and the
      // pipeline's end callback settles usage + writes the request log.
      this.streamConvert(
        upRes,
        res,
        ctx,
        provider,
        upstreamModel,
        route,
        status,
        headers,
        startedAt,
      );
      return { committed: true, deferred: true, status };
    }
    if (isJson(headers)) {
      const usage = await this.bufferConvert(
        upRes,
        res,
        ctx,
        provider,
        route,
        status,
        headers,
      );
      // Settlement + logging happen centrally in forward(); hand back the
      // actual counts (falling back to the input estimate when the upstream
      // reported nothing).
      return {
        committed: true,
        status,
        inputTokens: usage.input ?? ctx.inputTokens,
        outputTokens: usage.output ?? null,
        cachedTokens: usage.cached ?? null,
        debugResponse: usage.debugResponse ?? null,
      };
    }
    this.pipeThrough(upRes, res, status, headers);
    return {
      committed: true,
      status,
      inputTokens: ctx.inputTokens,
      outputTokens: null,
    };
  }

  // --- streaming 2xx --------------------------------------------------------
  //
  // Pipeline: providerSSE -> thinkingTransform(providerFmt) -> [streamBridge]
  //         -> ping -> client. The thinking transform runs first so <thinking>
  // extraction happens in the provider's native shape; the streamBridge then
  // converts SSE event shapes from providerFmt to the client's format.
  private streamConvert(
    upRes: IncomingMessage,
    res: Response,
    ctx: ForwardContext,
    provider: Provider,
    upstreamModel: string,
    route: Route,
    status: number,
    headers: IncomingMessage["headers"],
    startedAt: number,
  ): void {
    const out = filteredHeaders(headers);
    delete out["content-length"];
    delete out["Content-Length"];
    if (route.convert) out["content-type"] = "text/event-stream";

    const thinking = thinkingStream(route.providerFmt);
    const bridge =
      route.convert && route.streamBridge ? route.streamBridge() : null;

    // Unsupported streaming conversion — end gracefully with a clear note.
    // Settle the reservation (no usage to apply) and log the failure since the
    // normal end-of-pipeline path below won't run.
    if (route.convert && !bridge) {
      this.logger.warn("stream_conversion_unsupported", {
        providerFmt: route.providerFmt,
      });
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              type: "upstream_error",
              message: "Gateway cannot stream-convert this provider format",
              source: "gateway",
            },
          }),
        );
      }
      upRes.resume();
      this.settleUsage(ctx, provider, {});
      this.recordLog(
        ctx,
        provider,
        upstreamModel,
        502,
        ctx.inputTokens || null,
        null,
        null,
        "stream conversion unsupported",
        startedAt,
      );
      return;
    }

    // First stage: a pass-through observer that sniffs token usage out of the
    // PROVIDER-native SSE bytes (before any format bridge mangles field names)
    // without altering the stream. When debug is on it also accumulates the
    // response text + tool calls — still per-event, never buffering the stream.
    const usageObserver = new SseUsageObserver({ capture: ctx.debug });

    const ping =
      this.ssePingInterval > 0
        ? new SsePingKeepAlive({ interval: this.ssePingInterval })
        : null;

    res.on("error", (err: Error) =>
      this.logger.warn("client_res_error", { err: err.message }),
    );
    if (!res.headersSent) res.writeHead(status, out);

    // Settle usage + write the request log exactly once, when the stream ends
    // (whether it completed or the client aborted). The observer holds the best
    // usage numbers seen on the wire.
    let settled = false;
    const settle = (error: string | null) => {
      if (settled) return;
      settled = true;
      const usage = usageObserver.usage(ctx.inputTokens);
      this.settleUsage(ctx, provider, usage);
      let debugResponse: string | null = null;
      if (ctx.debug) {
        const summary = usageObserver.responseSummary();
        if (summary) {
          try {
            debugResponse = packResponseSummary(summary);
          } catch {
            debugResponse = null;
          }
        }
      }
      this.recordLog(
        ctx,
        provider,
        upstreamModel,
        status,
        usage.input ?? (ctx.inputTokens || null),
        usage.output ?? null,
        usage.cached ?? null,
        error,
        startedAt,
        debugResponse,
      );
    };

    // stream.pipeline propagates errors and destroy() across every stage, so a
    // client abort mid-stream tears down the upstream socket (and vice versa)
    // instead of leaking it. Plain .pipe() does not do this.
    const stages = [usageObserver, thinking, bridge, ping].filter(
      Boolean,
    ) as NodeJS.ReadWriteStream[];
    streamPipeline([upRes, ...stages, res], (err) => {
      if (!err) {
        settle(null);
        return;
      }
      const e = err as NodeJS.ErrnoException;
      // Client disconnects surface as ERR_STREAM_PREMATURE_CLOSE — routine.
      const aborted = e.code === "ERR_STREAM_PREMATURE_CLOSE";
      if (!aborted) {
        this.logger.warn("stream_pipeline_error", { err: e.message });
      }
      // Even on abort we still settle: the reservation must be reversed and the
      // partial usage observed so far attributed. Bytes already streamed to the
      // client are real usage.
      settle(aborted ? "client disconnected" : e.message);
      try {
        if (!res.writableEnded) res.end();
      } catch {
        /* noop */
      }
    });
  }

  // --- buffered non-streaming 2xx ------------------------------------------

  private async bufferConvert(
    upRes: IncomingMessage,
    res: Response,
    ctx: ForwardContext,
    provider: Provider,
    route: Route,
    status: number,
    headers: IncomingMessage["headers"],
  ): Promise<{
    input?: number;
    output?: number;
    cached?: number;
    debugResponse?: string | null;
  }> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of upRes) {
      const chunk = c as Buffer;
      size += chunk.length;
      if (size > MAX_BUFFER_BYTES) {
        if (!res.headersSent)
          res.status(502).json({
            error: {
              type: "upstream_error",
              message: "Upstream response too large to convert",
              source: "gateway",
            },
          });
        return {};
      }
      chunks.push(chunk);
    }

    const stripped = Buffer.from(
      stripInvisible(Buffer.concat(chunks).toString("utf8")),
      "utf8",
    );

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stripped.toString("utf8")) as Record<string, unknown>;
    } catch {
      this.sendRaw(res, status, headers, stripped);
      return {};
    }

    // Read the upstream-reported usage from the PROVIDER-shape body. Settlement
    // (reserve reversal + actual attribution) happens centrally in forward().
    const actual = readResponseUsage(parsed);

    // Debug capture: distill the response (text + tool calls + stop reason)
    // from the PROVIDER-shape body before any bridging.
    const debugResponse = ctx.debug ? safeCaptureResponse(parsed) : undefined;

    // 1) thinking extraction in PROVIDER format.
    applyThinking(this.thinking, route.providerFmt, parsed);

    // 2) bridge PROVIDER shape -> CLIENT shape (when converting).
    let outBody: unknown = parsed;
    if (route.convert && route.respConvert) {
      try {
        outBody = route.respConvert(parsed);
      } catch (err) {
        this.logger.warn("response_conversion_failed", {
          err: (err as Error).message,
        });
        this.sendRaw(res, status, headers, stripped);
        return { ...actual, debugResponse };
      }
    }

    const out = Buffer.from(JSON.stringify(outBody), "utf8");
    const outHeaders = filteredHeaders(headers);
    outHeaders["content-length"] = String(out.length);
    if (route.convert) outHeaders["content-type"] = "application/json";
    if (!res.headersSent) res.writeHead(status, outHeaders);
    res.end(out);
    return { ...actual, debugResponse };
  }

  // --- pass-through (non-SSE, non-JSON, or no conversion needed) -----------

  private pipeThrough(
    upRes: IncomingMessage,
    res: Response,
    status: number,
    headers: IncomingMessage["headers"],
  ): void {
    const out = filteredHeaders(headers);
    res.on("error", (err: Error) =>
      this.logger.warn("client_res_error", { err: err.message }),
    );
    if (!res.headersSent) res.writeHead(status, out);
    const ct = String(out["content-type"] || "").toLowerCase();
    const ping =
      ct.includes("text/event-stream") && this.ssePingInterval > 0
        ? new SsePingKeepAlive({ interval: this.ssePingInterval })
        : null;
    const stages = (ping ? [ping] : []) as NodeJS.ReadWriteStream[];
    streamPipeline([upRes, ...stages, res], (err) => {
      if (!err) return;
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ERR_STREAM_PREMATURE_CLOSE") {
        this.logger.warn("pipe_stream_error", { err: e.message });
      }
      try {
        if (!res.writableEnded) res.end();
      } catch {
        /* noop */
      }
    });
  }

  private sendRaw(
    res: Response,
    status: number,
    headers: IncomingMessage["headers"],
    buf: Buffer,
  ): void {
    if (res.headersSent) {
      try {
        if (!res.writableEnded) res.end();
      } catch {
        /* noop */
      }
      return;
    }
    res.writeHead(status, filteredHeaders(headers));
    res.end(buf);
  }

  // Single settlement point for per-key usage, shared by the streaming,
  // buffered, and failure paths. Reverses the exact optimistic reservation the
  // pipeline debited up front (input estimate + reserved max output), then
  // applies the actual total and attributes it to (key, model, provider).
  //
  // Every committed request calls this exactly once — that's what keeps the
  // three dashboard views (usage counter, request_logs, usage_breakdown) in
  // agreement: they all end up reflecting the same actual token total.
  private settleUsage(
    ctx: ForwardContext,
    provider: Provider | null,
    usage: { input?: number; output?: number },
  ): void {
    if (!ctx.apiKey) return;
    // 1) Release the reservation so it can't linger on the daily counter.
    if (ctx.reservedTokens > 0)
      subtractUsage(this.db, ctx.apiKey.id, ctx.reservedTokens);
    // 2) Apply the actual usage (input + output). Missing pieces already fell
    //    back to estimates upstream (streaming observer / buffered read).
    const total = (usage.input ?? 0) + (usage.output ?? 0);
    if (total > 0) {
      addUsage(this.db, ctx.apiKey.id, total);
      addBreakdown(
        this.db,
        ctx.apiKey.id,
        ctx.alias,
        provider?.id ?? null,
        total,
      );
    }
  }

  // --- single non-streaming turn (for the web-tool loop) --------------------
  //
  // Runs ONE upstream turn in Anthropic Messages shape and returns the parsed
  // Messages response. Reuses the same provider chain, routing and conversion
  // as forward(), but always non-streaming and self-contained (no client `res`
  // involvement). Used by the web-tool agent loop; the normal forward() path is
  // untouched. Returns { ok:false } with a reason on total failure.
  async runMessagesTurn(
    req: Request,
    ctx: ForwardContext,
    messagesBody: Record<string, unknown>,
  ): Promise<
    | { ok: true; body: Record<string, unknown>; usage: StreamUsageLike }
    | { ok: false; status: number; reason: string }
  > {
    const chain = this.buildChain(ctx.resolvedModel);
    if (chain.length === 0)
      return { ok: false, status: 502, reason: "no providers" };

    let lastReason = "no attempts";
    let lastStatus = 502;
    for (const entry of chain) {
      const route = this.buildRoute(
        "/v1/messages",
        entry.provider,
        entry.endpoint,
      );
      if (route.unsupported) {
        lastReason = route.unsupported;
        continue;
      }
      const attempts = Math.max(1, entry.provider.retryAttempts);
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const r = await this.runOneTurnAttempt(
          req,
          entry.provider,
          entry.upstreamModel,
          route,
          messagesBody,
        );
        if (r.ok) return r;
        lastReason = r.reason;
        lastStatus = r.status;
        if (r.retryable && attempt < attempts)
          await sleep(entry.provider.retryIntervalMs);
        else if (!r.retryable) break; // move to next provider
      }
    }
    return { ok: false, status: lastStatus, reason: lastReason };
  }

  private async runOneTurnAttempt(
    req: Request,
    provider: Provider,
    upstreamModel: string,
    route: Route,
    messagesBody: Record<string, unknown>,
  ): Promise<
    | { ok: true; body: Record<string, unknown>; usage: StreamUsageLike }
    | { ok: false; status: number; reason: string; retryable: boolean }
  > {
    // Convert Messages -> provider format, force non-streaming, stamp model.
    let body: Record<string, unknown>;
    try {
      body = route.reqConvert
        ? route.reqConvert({ ...messagesBody })
        : { ...messagesBody };
    } catch (err) {
      return {
        ok: false,
        status: 500,
        reason: `request conversion failed: ${(err as Error).message}`,
        retryable: false,
      };
    }
    body.model = upstreamModel;
    delete body.stream;
    const serialized = JSON.stringify(body);

    let upstreamUrl: URL;
    try {
      upstreamUrl = new URL(route.forwardPath, provider.baseUrl);
    } catch {
      return {
        ok: false,
        status: 500,
        reason: `bad provider baseUrl: ${provider.baseUrl}`,
        retryable: false,
      };
    }
    const key = this.pickKey(provider);
    const headers = this.buildHeaders(
      req,
      provider,
      key,
      Buffer.byteLength(serialized),
    );

    let res: JsonResponse;
    try {
      res = await requestJson({
        url: upstreamUrl.toString(),
        headers,
        body: serialized,
        timeoutMs: provider.requestTimeoutMs,
        tlsVerify: provider.tlsVerify,
      });
    } catch (err) {
      return {
        ok: false,
        status: 502,
        reason: (err as Error).message,
        retryable: true,
      };
    }

    if (RETRY_STATUS.has(res.status))
      return {
        ok: false,
        status: res.status,
        reason: `status ${res.status}`,
        retryable: true,
      };
    if (res.status < 200 || res.status >= 300)
      return {
        ok: false,
        status: res.status,
        reason: `upstream ${res.status}: ${res.text.slice(0, 300)}`,
        retryable: false,
      };

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stripInvisible(res.text)) as Record<string, unknown>;
    } catch (err) {
      return {
        ok: false,
        status: 502,
        reason: `bad upstream JSON: ${(err as Error).message}`,
        retryable: false,
      };
    }

    // Bridge provider-shape -> Messages shape so the loop always sees Messages.
    applyThinking(this.thinking, route.providerFmt, parsed);
    let messages: Record<string, unknown> = parsed;
    if (route.convert && route.respConvert) {
      try {
        messages = route.respConvert(parsed);
      } catch {
        messages = parsed;
      }
    }
    const usage = readResponseUsage(parsed);
    return { ok: true, body: messages, usage };
  }

  // --- web-tool loop hook ---------------------------------------------------

  private hasWebTools(body: Record<string, unknown>): boolean {
    const p = detectWebTools(body);
    return p.search || p.fetch;
  }

  // Drive the Firecrawl-backed web-tool loop for one request, then settle usage
  // + write the request log exactly once (same accounting as a normal request).
  private async forwardWebToolLoop(
    req: Request,
    res: Response,
    ctx: ForwardContext,
    startedAt: number,
  ): Promise<void> {
    const present = detectWebTools(ctx.requestBody);
    const cfg = ctx.webTools!;
    // Upstream provider for logging attribution only (the loop selects the
    // upstream internally per turn via runMessagesTurn -> buildChain).
    const chain = this.buildChain(ctx.resolvedModel);
    const logProvider = chain[0]?.provider ?? null;
    const upstreamModel = chain[0]?.upstreamModel ?? null;

    this.logger.info("web_tool_loop_start", {
      model: ctx.alias,
      provider: cfg.provider || DEFAULT_PROVIDER,
      search: present.search,
      fetch: present.fetch,
      stream: ctx.isStream,
    });

    // The web provider that actually runs search/fetch (Firecrawl, etc.).
    const webProvider = getWebProvider({
      provider: cfg.provider || DEFAULT_PROVIDER,
      baseUrl: cfg.baseUrl || undefined,
      apiKey: cfg.apiKey || null,
    });

    let result: {
      status: number;
      usage: StreamUsageLike;
      error: string | null;
    };
    try {
      result = await runWebToolLoop(req, res, ctx, present, {
        engine: this,
        logger: this.logger,
        provider: webProvider,
      });
    } catch (err) {
      result = {
        status: 502,
        usage: {},
        error: `web-tool loop crashed: ${(err as Error).message}`,
      };
    }

    if (result.error && !res.headersSent) {
      this.finish502(res, result.error);
    }

    this.settleUsage(ctx, logProvider, result.usage);
    this.recordLog(
      ctx,
      logProvider,
      upstreamModel,
      result.error ? result.status : 200,
      result.usage.input ?? (ctx.inputTokens || null),
      result.usage.output ?? null,
      result.usage.cached ?? null,
      result.error ?? null,
      startedAt,
      null,
    );
  }

  // --- request logging ------------------------------------------------------

  private recordLog(
    ctx: ForwardContext,
    provider: Provider | null,
    upstreamModel: string | null,
    status: number | null,
    inputTokens: number | null,
    outputTokens: number | null,
    cachedTokens: number | null,
    error: string | null,
    startedAt?: number,
    debugResponse?: string | null,
  ): void {
    try {
      insertRequestLog(this.db, {
        apiKeyId: ctx.apiKey?.id ?? null,
        apiKeyName: ctx.apiKey?.name ?? null,
        userId: ctx.apiKey?.userId ?? null,
        model: ctx.alias,
        providerId: provider?.id ?? null,
        providerName: provider?.name ?? null,
        upstreamModel,
        status,
        inputTokens,
        outputTokens,
        cachedTokens,
        latencyMs: startedAt ? Date.now() - startedAt : null,
        client: ctx.client,
        path: ctx.clientPath,
        stream: ctx.isStream,
        error,
        debugRequest: ctx.debug ? (ctx.debugRequest ?? null) : null,
        debugResponse: ctx.debug ? (debugResponse ?? null) : null,
      });
    } catch (err) {
      this.logger.warn("log_insert_failed", { err: (err as Error).message });
    }
  }

  // --- headers + round-robin key rotation -----------------------------------

  // Pick the next API key for the provider, round-robin. With N keys the call
  // cycles 0,1,…,N-1,0,1,… so load is spread evenly across requests. Returns
  // null when the provider has no keys configured.
  private pickKey(provider: Provider): string | null {
    const keys = provider.apiKeys;
    if (!keys.length) return null;
    const idx = this.keyCursor.get(provider.id) ?? 0;
    this.keyCursor.set(provider.id, (idx + 1) % keys.length);
    return keys[idx % keys.length];
  }

  private buildHeaders(
    req: Request,
    provider: Provider,
    key: string | null,
    bodyLen: number,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    const clientHeaders = (req.headers || {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(clientHeaders)) {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk)) continue;
      if (
        lk === "host" ||
        lk === "content-length" ||
        lk === "authorization" ||
        lk === "x-api-key"
      )
        continue;
      if (v === undefined) continue;
      out[k] = Array.isArray(v) ? (v[0] as string) : (v as string);
    }
    out["host"] = provider.host || hostFromUrl(provider.baseUrl);
    if (key) {
      if (provider.authScheme === "bearer" || provider.authScheme === "both")
        out["authorization"] = `Bearer ${key}`;
      if (provider.authScheme === "xapikey" || provider.authScheme === "both")
        out["x-api-key"] = key;
    }
    for (const [k, v] of Object.entries(provider.extraHeaders || {}))
      out[k] = v;
    out["content-length"] = String(bodyLen);
    if (!out["content-type"]) out["content-type"] = "application/json";
    if (!out["accept"]) out["accept"] = "application/json";
    return out;
  }
}

// ===========================================================================
// Conversion tables (clientFmt <-> providerFmt)
// ===========================================================================

type BodyConverter = (b: Record<string, unknown>) => Record<string, unknown>;

function identity(b: Record<string, unknown>): Record<string, unknown> {
  return b;
}

// Debug capture must never break the response path — swallow any error.
function safeCaptureResponse(
  parsed: Record<string, unknown>,
): string | undefined {
  try {
    return captureResponse(parsed);
  } catch {
    return undefined;
  }
}

// Request: from -> to.
function reqConverter(from: Fmt, to: Fmt): BodyConverter | null {
  if (from === to) return identity;
  if (from === "messages" && to === "chat") return messagesRequestToChat;
  if (from === "chat" && to === "messages") return chatRequestToMessages;
  if (from === "responses" && to === "chat")
    return (b) => responsesRequestToChat(b);
  return null;
}

// Non-streaming response: from -> to.
function respConverter(from: Fmt, to: Fmt): BodyConverter | null {
  if (from === to) return identity;
  if (from === "chat" && to === "messages") return chatResponseToMessages;
  if (from === "messages" && to === "chat") return messagesResponseToChat;
  if (from === "chat" && to === "responses")
    return (b) => responsesResponseFromChat(b);
  return null;
}

// Streaming response bridge factory: providerFmt -> clientFmt SSE transform.
function streamBridgeFactory(from: Fmt, to: Fmt): (() => Transform) | null {
  if (from === to) return null;
  if (from === "chat" && to === "messages")
    return () => new ChatToMessagesSseTransform();
  if (from === "messages" && to === "chat")
    return () => new MessagesToChatSseTransform();
  if (from === "chat" && to === "responses")
    return () => new StreamingResponsesBridgeTransform();
  return null;
}

// Lazily-bound wrappers around ResponsesBridge (kept instance-bound on the
// engine via module-singleton to avoid per-request allocation).
const responsesBridgeSingleton = new ResponsesBridge();
function responsesRequestToChat(
  b: Record<string, unknown>,
): Record<string, unknown> {
  return responsesBridgeSingleton.requestToChatCompletions(b);
}
function responsesResponseFromChat(
  b: Record<string, unknown>,
): Record<string, unknown> {
  const r = responsesBridgeSingleton.responseFromChatCompletions(b);
  return (r ?? b) as Record<string, unknown>;
}

// --- thinking helpers ------------------------------------------------------

function applyThinking(
  conv: ThinkingConverter,
  fmt: Fmt,
  body: Record<string, unknown>,
): void {
  try {
    if (fmt === "chat") conv.applyToChatCompletion(body as never);
    else if (fmt === "messages") conv.applyToAnthropicMessage(body as never);
    else if (fmt === "responses") conv.applyToResponse(body as never);
  } catch {
    /* leave body untouched on transform error */
  }
}

// Pick the streaming thinking transform for a provider format. Returns null
// when there's no streaming thinking transform (e.g. responses).
function thinkingStream(fmt: Fmt): NodeJS.ReadWriteStream | null {
  if (fmt === "chat") return new SseThinkingTransform();
  if (fmt === "messages") return new AnthropicThinkingTransform();
  return null;
}

// --- header helpers --------------------------------------------------------

function isEventStream(headers: IncomingMessage["headers"]): boolean {
  return String(headers?.["content-type"] || "")
    .toLowerCase()
    .includes("text/event-stream");
}
function isJson(headers: IncomingMessage["headers"]): boolean {
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

function filteredHeaders(
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

function hostFromUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
