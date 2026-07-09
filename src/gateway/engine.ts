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
import { randomBytes } from "crypto";
import { pipeline as streamPipeline } from "stream";
import type { IncomingMessage } from "http";
import type { Request, Response } from "express";
import type { Database as DB } from "better-sqlite3";
import type { Logger } from "../logger";
import type {
  ApiKey,
  Model,
  Provider,
  ModelTransformConfig,
} from "../types";
import { agentFor } from "./proxy-agent";
import { buildUpstreamUrl, hostFromUrl } from "./url";
import { adapterForProvider } from "../providers";
import { getProviderModel } from "../repo/provider-models";
import { modelTransformBags } from "../formats/transforms";
import {
  KeyHealthStore,
  parseRateLimit,
  AUTH_FAIL_STATUS,
  type KeyPick,
} from "./key-health";
import { ThinkingConverter } from "../formats/thinking";
import {
  buildTransformPlan,
  applyBodyTransforms,
  applyThinking,
  thinkingStream,
  type TransformCtx,
  type RequestTransform,
  type ResponseTransform,
  type StreamTransform,
} from "../formats/pipeline";
import { SsePingKeepAlive } from "./sse-ping";
import { SseUsageObserver } from "./sse-usage";
import { requestJson, type JsonResponse } from "./http";
import { detectWebTools } from "../web-tools/tools";
import { runWebToolLoop } from "../web-tools/loop";
import { getWebProvider, DEFAULT_PROVIDER } from "../web-tools/backends";
import { stripInvisible } from "../utils";
import { readResponseUsage, readMaxOutputTokens } from "../formats/tokens";
import { listProviders } from "../repo/providers";
import { addUsage, subtractUsage, addBreakdown } from "../repo/usage";
import { insertRequestLog } from "../repo/request-logs";
import { getSetting } from "../repo/settings";
import {
  captureRequest,
  captureResponse,
  packResponseSummary,
} from "./debug-capture";

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

// One resolved hop in a model's fallback chain: the provider to try, the
// upstream model id, its endpoint, plus the effective per-hop context window
// (link override ?? imported-model base) and the imported model's transforms.
interface ChainEntry {
  provider: Provider;
  upstreamModel: string;
  endpoint: string | null;
  contextWindow: number | null;
  transforms: ModelTransformConfig[];
}

// Per-attempt route plan: where to send + the ordered transform stages (format
// conversion + any adapter-custom transforms) for request, response and stream.
// Built by buildRoute from the provider adapter + formats/pipeline.
interface Route {
  forwardPath: string;
  providerFmt: Fmt;
  convert: boolean;
  /** Ordered request-body stages (client -> provider), then custom. */
  request: RequestTransform[];
  /** Ordered buffered-response stages (provider -> client), then custom. */
  response: ResponseTransform[];
  /** Ordered SSE stages (format bridge, then custom). */
  stream: StreamTransform[];
  /** True when a format-level stream bridge is present (for the unsupported check). */
  streamBridged: boolean;
  /** Context passed to every transform. */
  xctx: TransformCtx;
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
  /** Short correlation id for this request, set only when debug logging is on.
   *  When present it enables the per-transformation trace and ties the trace,
   *  attempts, and the final summary line together. */
  reqId?: string;
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
  /** Hash of the upstream key used, so forward() can record its health. */
  keyHash?: string | null;
  /** Cooldown (ms) parsed from a 429 response's Retry-After, for the key. */
  rateLimitMs?: number;
}

// Upstream-reported usage shape (subset of readResponseUsage's return).
interface StreamUsageLike {
  input?: number;
  output?: number;
  cached?: number;
}

export class ForwardingEngine {
  private readonly keyHealth: KeyHealthStore;

  constructor(
    private readonly db: DB,
    private readonly logger: Logger,
    private readonly thinking: ThinkingConverter,
    private readonly ssePingInterval: number,
  ) {
    this.keyHealth = new KeyHealthStore(db);
  }

  // SSE keepalive interval (ms) for callers that emit their own stream (e.g. the
  // web-tool loop, which writes a synthetic SSE response directly). 0 disables.
  get pingInterval(): number {
    return this.ssePingInterval;
  }

  // --- chain + route --------------------------------------------------------

  private buildChain(model: Model | null): ChainEntry[] {
    if (!model) return [];
    const enabledProviders = new Map(
      listProviders(this.db, false).map((p) => [p.id, p]),
    );
    const chain: ChainEntry[] = [];
    for (const link of model.providers) {
      if (!link.enabled) continue;
      const provider = enabledProviders.get(link.providerId);
      if (!provider || !provider.enabled) continue;
      // Resolve the imported provider-model this hop references, for its base
      // context window + per-model transforms. Link overrides win over the base.
      const imported = getProviderModel(
        this.db,
        provider.id,
        link.upstreamModel,
      );
      chain.push({
        provider,
        upstreamModel: link.upstreamModel,
        endpoint: link.endpoint ?? null,
        contextWindow:
          link.contextWindow ?? imported?.contextWindow ?? null,
        transforms: imported?.transforms ?? [],
      });
    }
    if (chain.length === 0) {
      for (const provider of enabledProviders.values())
        chain.push({
          provider,
          upstreamModel: model.alias,
          endpoint: null,
          contextWindow: null,
          transforms: [],
        });
    }
    return chain;
  }

  // Build the conversion plan for one attempt. Delegates the endpoint + native
  // format decision to the provider's adapter, then composes the ordered
  // transform stages (built-in format conversion + adapter-custom transforms)
  // via formats/pipeline. `onStage` logs the declared pipeline when debug is on.
  private buildRoute(
    clientPath: string,
    entry: ChainEntry,
    reqId?: string,
    alias?: string,
  ): Route {
    const { provider, endpoint } = entry;
    const clientFmt = pathFmt(clientPath) ?? "chat";
    const adapter = adapterForProvider(provider);

    // nativeConversion: provider accepts the client's format/endpoint directly,
    // no built-in conversion — but adapter-custom transforms still apply.
    const endpointPlan = provider.nativeConversion
      ? { forwardPath: clientPath.split("?")[0], providerFmt: clientFmt }
      : adapter.planFor(clientFmt, provider, endpoint);

    const xctx: TransformCtx = {
      provider,
      clientFmt,
      providerFmt: endpointPlan.providerFmt,
      alias,
      upstreamModel: entry.upstreamModel,
    };

    // reqId is supplied only when debug logging is on, so its presence gates the
    // per-stage trace (zero cost otherwise).
    const onStage = reqId
      ? (dir: string, name: string) =>
          this.logger.transform(dir, name, {
            provider: provider.id,
            fmt: `${clientFmt}->${endpointPlan.providerFmt}`,
            reqId,
          })
      : undefined;

    // Merge adapter (provider-scoped) + model (imported-model-scoped) transforms.
    // Model stages run after adapter stages within each phase.
    const adapterBag = adapter.transforms(provider);
    const modelBag = modelTransformBags(entry.transforms);
    const extra = {
      request: [...(adapterBag.request ?? []), ...modelBag.request],
      response: [...(adapterBag.response ?? []), ...modelBag.response],
      stream: adapterBag.stream ?? [],
    };

    const plan = buildTransformPlan(clientFmt, endpointPlan, extra, onStage);

    return {
      forwardPath: plan.forwardPath,
      providerFmt: plan.providerFmt,
      convert: clientFmt !== plan.providerFmt,
      request: plan.request,
      response: plan.response,
      stream: plan.stream,
      streamBridged: plan.stream.some((s) => s.name.startsWith("stream:")),
      xctx,
      unsupported: plan.unsupported,
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
    // (no extra buffering). Captured for every attempt's log row. When debug is
    // on, stamp a short correlation id that enables the per-transformation trace.
    if (ctx.debug) {
      ctx.reqId = shortId();
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

    let chain: ChainEntry[];
    try {
      chain = this.buildChain(ctx.resolvedModel);
    } catch (err) {
      // A DB read while building the chain failed (e.g. SQLITE_BUSY). Fail the
      // request cleanly instead of letting the rejection escape to a 500.
      this.logger.error("build_chain_failed", { err: (err as Error).message });
      this.finish502(res, "Gateway could not resolve the provider chain.");
      this.recordLog(
        ctx,
        null,
        null,
        502,
        null,
        null,
        null,
        `build chain failed: ${(err as Error).message}`,
        startedAt,
      );
      return;
    }
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
    let first: ChainEntry | null = null;
    for (const entry of chain) {
      if (!first) first = entry;
      // Safe fallback: if this hop advertises a context window this request
      // would exceed, skip it and try the next provider rather than sending an
      // oversized request that will fail upstream.
      const maxOut =
        readMaxOutputTokens(ctx.requestBody) ??
        ctx.resolvedModel?.maxOutputTokens ??
        0;
      if (
        entry.contextWindow &&
        entry.contextWindow > 0 &&
        ctx.inputTokens + maxOut > entry.contextWindow
      ) {
        lastReason = `hop context window ${entry.contextWindow} < projected ${ctx.inputTokens + maxOut}`;
        this.logger.warn("context_skip", {
          provider: entry.provider.id,
          model: entry.upstreamModel,
          hopContextWindow: entry.contextWindow,
          projected: ctx.inputTokens + maxOut,
        });
        continue; // fall through to the next hop
      }
      let route: Route;
      try {
        route = this.buildRoute(ctx.clientPath, entry, ctx.reqId, ctx.alias);
      } catch (err) {
        // A bespoke adapter or transform threw while building the plan. Treat it
        // like an unsupported hop and fall over to the next provider.
        lastReason = `route build failed: ${(err as Error).message}`;
        this.logger.warn("route_build_failed", {
          provider: entry.provider.id,
          model: entry.upstreamModel,
          err: (err as Error).message,
        });
        continue;
      }
      if (route.unsupported) {
        lastReason = route.unsupported;
        this.logger.warn("conversion_unsupported", {
          provider: entry.provider.id,
          model: entry.upstreamModel,
          detail: lastReason,
        });
        continue; // try the next provider in the chain
      }
      // Attempt budget: at least the provider's configured retries, but widened
      // so a multi-key provider can fail a rate-limited/auth-failed key over to
      // a healthy one within this request (bounded by the key count).
      const usable = this.keyHealth.usableCount(entry.provider);
      const attempts = Math.max(
        1,
        entry.provider.retryAttempts,
        Math.min(usable || 1, entry.provider.apiKeys.length || 1),
      );
      const tried = new Set<string>();
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (res.headersSent || res.writableEnded) return;
        const pick = this.keyHealth.select(
          entry.provider,
          entry.upstreamModel,
          tried,
        );
        if (pick) tried.add(pick.keyHash);
        const result = await this.attemptOnce(
          req,
          res,
          ctx,
          entry,
          route,
          startedAt,
          pick,
        );
        // Feed the outcome back into key health (skip client-disconnect 499).
        if (pick && result.status !== 499) {
          if (result.committed && result.status && result.status < 400) {
            this.keyHealth.recordSuccess(
              entry.provider.id,
              pick.keyHash,
              entry.upstreamModel,
            );
          } else if (result.status && AUTH_FAIL_STATUS.has(result.status)) {
            this.keyHealth.markAuthFailed(entry.provider.id, pick.keyHash);
          } else if (result.status === 429) {
            this.keyHealth.markRateLimited(
              entry.provider.id,
              pick.keyHash,
              result.rateLimitMs ?? 60_000,
            );
            this.keyHealth.recordFailure(
              entry.provider.id,
              pick.keyHash,
              entry.upstreamModel,
            );
          } else if (!result.committed) {
            this.keyHealth.recordFailure(
              entry.provider.id,
              pick.keyHash,
              entry.upstreamModel,
            );
          }
        }
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
    pick: KeyPick | null,
  ): Promise<AttemptResult> {
    const { provider, upstreamModel } = entry;
    const keyHash = pick?.keyHash ?? null;

    // Run the request through its ordered transform stages (format conversion
    // then any adapter-custom stages), then stamp the upstream model id. Falls
    // back to the original body on conversion error.
    let serialized: Buffer;
    try {
      const body = applyBodyTransforms(
        route.request,
        { ...ctx.requestBody },
        route.xctx,
        this.stageApplyLogger(ctx, "req"),
      );
      body.model = upstreamModel;
      // JSON.stringify can throw on a BigInt / circular structure a transform
      // produced — keep it inside the guard so the attempt fails over cleanly.
      serialized = Buffer.from(JSON.stringify(body), "utf8");
    } catch (err) {
      return Promise.resolve({
        committed: false,
        reason: `request conversion failed: ${(err as Error).message}`,
      });
    }

    let upstreamUrl: URL;
    try {
      // Join base + path by concatenation (not `new URL(path, base)`, which
      // discards any path prefix in baseUrl). Composes origin + basePath +
      // forwardPath so Gemini-style layouts and OpenRouter's `/api` both work.
      upstreamUrl = buildUpstreamUrl(provider, route.forwardPath);
    } catch {
      return Promise.resolve({
        committed: false,
        reason: `bad provider baseUrl: ${provider.baseUrl}`,
      });
    }
    const key = pick?.key ?? null;
    const headers = this.buildHeaders(req, provider, key, serialized.length);
    const isHttps = upstreamUrl.protocol === "https:";
    const transport = isHttps ? https : http;
    let proxyAgent: ReturnType<typeof agentFor>;
    try {
      proxyAgent = agentFor(provider.proxy, isHttps);
    } catch (err) {
      return Promise.resolve({
        committed: false,
        reason: `bad provider proxy: ${(err as Error).message}`,
      });
    }

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
        // Stamp the key used so forward() can attribute the outcome to it.
        resolvePromise({ ...r, keyHash: r.keyHash ?? keyHash });
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
          ...(proxyAgent ? { agent: proxyAgent } : {}),
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
      // Parse the cooldown so forward() can rate-limit this key for the right
      // duration before failing over.
      const rateLimitMs =
        status === 429 ? parseRateLimit(headers) : undefined;
      return { committed: false, status, reason: `status ${status}`, rateLimitMs };
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
    // Materialize the ordered SSE stages from the plan (format bridge, then any
    // adapter-custom stream transforms). Log the assembled pipeline once here —
    // never per event.
    const streamStages = route.stream.map((s) => {
      if (ctx.reqId)
        this.logger.transform("stream", s.name, {
          provider: provider.id,
          reqId: ctx.reqId,
        });
      return s.create(route.xctx);
    });

    // Unsupported streaming conversion — a format bridge was required but none
    // exists. End gracefully with a clear note; settle the reservation and log
    // the failure since the normal end-of-pipeline path below won't run.
    if (route.convert && !route.streamBridged) {
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
    const stages = [usageObserver, thinking, ...streamStages, ping].filter(
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

    // 1) thinking extraction in PROVIDER format (reads provider-native fields,
    //    so it runs before the format/custom response stages).
    applyThinking(this.thinking, route.providerFmt, parsed);

    // 2) run the response through its ordered transform stages (format bridge
    //    provider->client, then adapter-custom stages).
    let outBody: unknown = parsed;
    try {
      outBody = applyBodyTransforms(
        route.response,
        parsed,
        route.xctx,
        this.stageApplyLogger(ctx, "resp"),
      );
    } catch (err) {
      this.logger.warn("response_conversion_failed", {
        err: (err as Error).message,
      });
      this.sendRaw(res, status, headers, stripped);
      return { ...actual, debugResponse };
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
    // These are raw better-sqlite3 writes; a transient DB error must not escape
    // — several callers run in stream/end callbacks where a throw would be an
    // uncaught exception. Accounting drift on a rare write failure is acceptable.
    try {
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
    } catch (err) {
      this.logger.warn("settle_usage_failed", { err: (err as Error).message });
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
        entry,
        ctx.reqId,
        ctx.alias,
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
    // Convert Messages -> provider format (via the ordered request stages),
    // force non-streaming, stamp model.
    let body: Record<string, unknown>;
    try {
      body = applyBodyTransforms(route.request, { ...messagesBody }, route.xctx);
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
      upstreamUrl = buildUpstreamUrl(provider, route.forwardPath);
    } catch {
      return {
        ok: false,
        status: 500,
        reason: `bad provider baseUrl: ${provider.baseUrl}`,
        retryable: false,
      };
    }
    // Health-aware key pick for the (non-streaming) web-tool turn. Each turn is
    // a fresh selection so a rate-limited/auth-failed key is skipped.
    const pick = this.keyHealth.select(provider, upstreamModel, new Set());
    const headers = this.buildHeaders(
      req,
      provider,
      pick?.key ?? null,
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
        agent: agentFor(provider.proxy, upstreamUrl.protocol === "https:"),
      });
    } catch (err) {
      return {
        ok: false,
        status: 502,
        reason: (err as Error).message,
        retryable: true,
      };
    }

    if (RETRY_STATUS.has(res.status)) {
      if (pick && res.status === 429)
        this.keyHealth.markRateLimited(provider.id, pick.keyHash, 60_000);
      return {
        ok: false,
        status: res.status,
        reason: `status ${res.status}`,
        retryable: true,
      };
    }
    if (res.status < 200 || res.status >= 300) {
      if (pick && AUTH_FAIL_STATUS.has(res.status))
        this.keyHealth.markAuthFailed(provider.id, pick.keyHash);
      return {
        ok: false,
        status: res.status,
        reason: `upstream ${res.status}: ${res.text.slice(0, 300)}`,
        retryable: false,
      };
    }

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
    try {
      messages = applyBodyTransforms(route.response, parsed, route.xctx);
    } catch {
      messages = parsed;
    }
    if (pick)
      this.keyHealth.recordSuccess(provider.id, pick.keyHash, upstreamModel);
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

  // --- transform trace -------------------------------------------------------

  // Build the per-stage apply callback for applyBodyTransforms. Returns
  // undefined when debug logging is off (ctx.reqId unset) so there's zero cost.
  private stageApplyLogger(
    ctx: ForwardContext,
    dir: "req" | "resp",
  ): ((name: string, changed: boolean) => void) | undefined {
    const reqId = ctx.reqId;
    if (!reqId) return undefined;
    return (name, changed) =>
      this.logger.transform(dir, name, { reqId, changed });
  }

  // --- headers --------------------------------------------------------------
  // Key selection + round-robin rotation now live in KeyHealthStore (this.keyHealth).

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

// Format conversion tables + thinking helpers now live in formats/pipeline.ts
// (imported above). Only response-path helpers specific to the engine remain.

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

// Short correlation id for a request's transform trace (8 hex chars).
function shortId(): string {
  return randomBytes(4).toString("hex");
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
