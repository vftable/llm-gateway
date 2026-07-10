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
import { pipeline as streamPipeline, PassThrough } from "stream";
import type { IncomingMessage } from "http";
import type { Request, Response } from "express";
import type { Database as DB } from "better-sqlite3";
import type { Logger } from "../logger";
import type { Model, Provider } from "../types";
import { agentFor } from "./proxy-agent";
import { buildUpstreamUrl, hostFromUrl } from "./url";
import {
  adapterForProvider,
  wireFmtOf,
  endsWithKnownSuffix,
  familyDefaultTransforms,
  applyAuthHeaders,
  type EndpointRoute,
} from "../providers";
import { getProviderModel } from "../repo/provider-models";
import {
  modelTransformBags,
  dropOverriddenDefaults,
} from "../formats/transforms";
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
  type TransformCtx,
} from "../formats/pipeline";
import { collectDefaults } from "../formats/transforms/defaults";
import { SsePingKeepAlive } from "./sse-ping";
import { SseUsageObserver } from "./sse-usage";
import { requestJson, type JsonResponse } from "./http";
import { detectWebTools } from "../web-tools/tools";
import { runWebToolLoop } from "../web-tools/loop";
import { getWebProvider, DEFAULT_PROVIDER } from "../web-tools/backends";
import { chatRequestToMessages } from "../formats/converters/chat-messages";
import { stripInvisible } from "../utils";
import { readResponseUsage, readMaxOutputTokens } from "../formats/tokens";
import { listProviders } from "../repo/providers";
import { addUsage, subtractUsage, addBreakdown } from "../repo/usage";
import { insertRequestLog } from "../repo/request-logs";
import { captureRequest, packResponseSummary } from "./debug-capture";
import type {
  ChainEntry,
  Route,
  AttemptResult,
  StreamUsageLike,
} from "./engine-support/types";
import {
  HOP_BY_HOP,
  RETRY_STATUS,
  MAX_BUFFER_BYTES,
  pathFmt,
  makeResolve,
  safeCaptureResponse,
  shortId,
  isEventStream,
  isJson,
  filteredHeaders,
  sleep,
} from "./engine-support/utils";

export type { ForwardContext } from "./engine-support/types";
import type { ForwardContext } from "./engine-support/types";

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

  // Health-aware key pick using the SAME live rotation/health state a real
  // request would get (this.keyHealth is shared with the forward() path) —
  // for the admin "Test connection" probe, so the reported key isn't a fake
  // stand-in but the actual next-in-line pick (skips cooling-down/auth-failed
  // keys, honors model affinity). Like a real select(), this DOES advance the
  // round-robin cursor — a test click consumes a rotation slot exactly like a
  // real request would, so back-to-back tests cycle through the pool instead
  // of always reporting the same key. It does NOT call recordSuccess/
  // recordFailure/markAuthFailed — the probe itself does its own HTTP call and
  // reports its own status, not through the key-health feedback loop. Returns
  // null only when the provider has no keys at all.
  pickKeyForTest(provider: Provider, model: string | null): KeyPick | null {
    return this.keyHealth.select(provider, model, new Set());
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
        contextWindow: link.contextWindow ?? imported?.contextWindow ?? null,
        maxOutputTokens:
          link.maxOutputTokens ??
          imported?.maxOutputTokens ??
          model.maxOutputTokens ??
          null,
        // Family default transforms form an always-on BASE layer; the imported
        // model's own transforms override by (id, phase). Even a model with no
        // configured transforms gets its family's sensible defaults. Kept
        // separate from ownTransforms so buildRoute can place family defaults
        // BEFORE the adapter's own transform stack and own transforms AFTER.
        familyTransforms: dropOverriddenDefaults(
          familyDefaultTransforms(provider),
          imported?.transforms ?? [],
        ),
        ownTransforms: imported?.transforms ?? [],
      });
    }
    if (chain.length === 0) {
      for (const provider of enabledProviders.values())
        chain.push({
          provider,
          upstreamModel: model.alias,
          endpoint: null,
          contextWindow: null,
          maxOutputTokens: model.maxOutputTokens ?? null,
          familyTransforms: familyDefaultTransforms(provider),
          ownTransforms: [],
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

    // nativeConversion: the provider accepts all three wire formats and converts
    // to its model internally. The per-hop endpoint chooses WHICH format the
    // gateway hands it — the gateway still converts client -> picked format, then
    // the provider does the rest. "Auto" (no per-link endpoint) forwards the
    // client's own format + path unchanged (no gateway conversion).
    const endpointPlan: EndpointRoute = provider.nativeConversion
      ? endpoint && endsWithKnownSuffix(endpoint)
        ? {
            forwardPath: endpoint,
            endpointKind: wireFmtOf(endpoint, clientFmt),
            providerFmt: wireFmtOf(endpoint, clientFmt),
          }
        : {
            forwardPath: clientPath.split("?")[0],
            endpointKind: clientFmt,
            providerFmt: clientFmt,
          }
      : adapter.routeFor(clientFmt, provider, endpoint, entry.upstreamModel);

    const xctx: TransformCtx = {
      provider,
      clientFmt,
      providerFmt: endpointPlan.providerFmt,
      alias,
      upstreamModel: entry.upstreamModel,
      maxOutputTokens: entry.maxOutputTokens,
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

    // Compose the pipeline's custom stages. Every stage is either format-tagged
    // (placed by buildTransformPlan relative to the wire conversion) or untagged
    // (placed post, historical). Sources, in order:
    //   1. default transforms: the all-provider registry (anthropic hooks,
    //      thinking) — declared in formats/transforms/defaults, each format-
    //      tagged so it lands in the right slot for this hop.
    //   2. family transforms: the provider family's library-backed defaults
    //      (e.g. anthropic-cache), minus anything the model overrides — runs
    //      BEFORE the adapter's own stack so e.g. prompt-caching breakpoints
    //      are in place before an adapter-specific stage (like the
    //      anthropic-subscription hooks) inspects/rewrites the body.
    //   3. adapter transforms: the provider adapter's own tagged/untagged
    //      stages (e.g. anthropic-subscription's no-op framework).
    //   4. model transforms: the model's own overrides/additions — last, so an
    //      operator's explicit per-model customization always has the final
    //      say over both the family default and the adapter's stack.
    const defaults = collectDefaults({
      thinking: this.thinking,
      providerFmt: endpointPlan.providerFmt,
    });
    const familyBag = modelTransformBags(entry.familyTransforms);
    const adapterBag = adapter.transforms(provider);
    const ownBag = modelTransformBags(entry.ownTransforms);
    const extra = {
      request: [
        ...defaults.request,
        ...familyBag.request,
        ...(adapterBag.request ?? []),
        ...ownBag.request,
      ],
      response: [
        ...defaults.response,
        ...familyBag.response,
        ...(adapterBag.response ?? []),
        ...ownBag.response,
      ],
      stream: [...defaults.stream, ...(adapterBag.stream ?? [])],
    };

    const plan = buildTransformPlan(clientFmt, endpointPlan, extra, onStage);

    return {
      forwardPath: plan.forwardPath,
      endpointKind: endpointPlan.endpointKind,
      providerFmt: plan.providerFmt,
      clientFmt,
      convert: clientFmt !== plan.providerFmt,
      request: plan.request,
      response: plan.response,
      stream: plan.stream,
      streamBridged: plan.stream.some((s) => s.name.startsWith("stream:")),
      xctx,
      unsupported: plan.unsupported,
      // Phase-2 builder: assembles the outbound request after conversion.
      adapter,
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

    // Firecrawl-backed web tools: if enabled and this request asks for the hosted
    // web_search / web_fetch tools, hand the whole request to the agent loop (which
    // the gateway runs itself) instead of a single proxied turn. Detection is
    // format-agnostic (tool defs in Messages OR Chat shape — a Claude model behind
    // an OpenAI-type client), so both Messages and Chat clients qualify; the loop
    // works in Messages shape internally and emits back in the client's format.
    // Responses clients (`input`, not `messages`) fall through to the normal proxy.
    const clientFmt = pathFmt(ctx.clientPath);
    if (
      ctx.webTools?.enabled &&
      (clientFmt === "messages" || clientFmt === "chat") &&
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

    // Fresh per-attempt ctx so a request hook's URL/header rewrites can't leak
    // across retries/hops (route.xctx is shared for the whole request).
    const attemptCtx: TransformCtx = {
      ...route.xctx,
      headerOverrides: undefined,
      urlOverride: undefined,
    };

    // Phase 1 — run the request through its ordered transform stages (format
    // conversion then any adapter-custom stages) and stamp the upstream model id.
    // A request hook may also set attemptCtx.headerOverrides / .urlOverride to
    // rewrite the outbound request; those are the defaults handed to the builder.
    const key = pick?.key ?? null;
    let serialized: Buffer;
    let upstreamUrl: URL;
    let headers: Record<string, string>;
    try {
      const converted = applyBodyTransforms(
        route.request,
        { ...ctx.requestBody },
        attemptCtx,
        this.stageApplyLogger(ctx, "req"),
      );
      converted.model = upstreamModel;

      // Default composed URL: a request hook's urlOverride wins, else the
      // origin+basePath+forwardPath composition (string concat, not
      // `new URL(path, base)`, which drops path prefixes — so Gemini-style
      // layouts and OpenRouter's `/api` both work).
      const defaultUrl =
        attemptCtx.urlOverride ??
        buildUpstreamUrl(provider, route.forwardPath).toString();
      // Default header set (client passthrough + auth + extraHeaders), with the
      // request hook's per-attempt overrides merged (string sets, null deletes).
      const defaultHeaders = this.buildHeaders(
        req,
        provider,
        key,
        attemptCtx.headerOverrides,
      );

      // Phase 2 — the adapter builds the final outbound request from the
      // converted body, the selected key, and the composed URL + headers. The
      // default builder forwards them verbatim; a bespoke provider may rewrite
      // url/headers/body via the URL parts + resolve() (no `new URL()` needed).
      // Runs LAST, so it wins over the request-hook overrides.
      const resolve = makeResolve(provider, route.forwardPath);
      const built = route.adapter.buildFor(route.providerFmt, {
        provider,
        model: upstreamModel,
        body: converted,
        apiKey: key,
        clientFmt: route.clientFmt,
        providerFmt: route.providerFmt,
        endpointKind: route.endpointKind,
        forwardPath: route.forwardPath,
        baseUrl: provider.baseUrl,
        basePath: provider.basePath,
        resolve,
        url: defaultUrl,
        headers: defaultHeaders,
      });

      // JSON.stringify can throw on a BigInt / circular structure a transform or
      // builder produced — keep it (and the URL parse) inside the guard so the
      // attempt fails over cleanly.
      serialized = Buffer.from(JSON.stringify(built.body), "utf8");
      upstreamUrl = new URL(built.url);
      headers = {
        ...built.headers,
        "content-length": String(serialized.length),
      };
    } catch (err) {
      return Promise.resolve({
        committed: false,
        reason: `request build failed: ${(err as Error).message}`,
      });
    }
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
      const rateLimitMs = status === 429 ? parseRateLimit(headers) : undefined;
      return {
        committed: false,
        status,
        reason: `status ${status}`,
        rateLimitMs,
      };
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

    // Materialize the ordered SSE stages from the plan: thinking (a pre-bridge,
    // provider-format-tagged default), the format bridge, then any adapter-custom
    // stream transforms. Log the assembled pipeline once here — never per event.
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

    // Prime the stream: write a ping the instant the SSE response opens, before
    // the upstream's first token. The longest idle gap on a streaming request is
    // the model's time-to-first-token; a client/proxy idle timer that starts now
    // would otherwise fire before any byte arrives. (The ping stage keeps pinging
    // on the interval thereafter.) SSE comment lines are ignored by clients.
    if (ping) {
      try {
        res.write(": ping\n\n");
      } catch {
        /* client already gone; the pipeline below will settle */
      }
    }

    // Idle watchdog: if the upstream goes silent mid-stream for longer than the
    // request timeout, tear it down so the failure SURFACES (a terminal error
    // event, below) instead of the socket hanging open until a proxy kills it.
    // A tiny head-tap timestamps each upstream chunk without altering bytes (so
    // the usageObserver still sees identical provider-native SSE).
    let lastActivity = Date.now();
    const headTap = new PassThrough();
    headTap.on("data", () => {
      lastActivity = Date.now();
    });
    const idleMs = provider.requestTimeoutMs;
    const idleTimer = setInterval(
      () => {
        if (Date.now() - lastActivity >= idleMs && !upRes.destroyed) {
          this.logger.warn("stream_idle_timeout", {
            provider: provider.id,
            model: upstreamModel,
            idleMs,
          });
          upRes.destroy(new Error(`upstream stream idle > ${idleMs}ms`));
        }
      },
      Math.max(1000, Math.floor(idleMs / 4)),
    );
    if (typeof (idleTimer as { unref?: () => void }).unref === "function")
      (idleTimer as { unref: () => void }).unref();

    // Settle usage + write the request log exactly once, when the stream ends
    // (whether it completed or the client aborted). The observer holds the best
    // usage numbers seen on the wire.
    let settled = false;
    const settle = (error: string | null) => {
      if (settled) return;
      settled = true;
      clearInterval(idleTimer);
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
    // instead of leaking it. Plain .pipe() does not do this. The usageObserver
    // must stay first (it sniffs provider-native token usage before any stage
    // rewrites field names); thinking + bridge + custom stages come from
    // streamStages (thinking is the plan's first, pre-bridge stage).
    // headTap (idle watchdog timestamps) runs first, then the usageObserver
    // (must see provider-native bytes before any rewrite), then thinking + bridge
    // + custom stages, then ping. The tap is a pure passthrough — zero byte change.
    // The pipeline sink is a PassThrough (`clientSink`), NOT `res` directly —
    // streamPipeline destroys its final stage on error, and we need `res` to stay
    // writable so we can emit a terminal SSE error event after a mid-stream
    // upstream failure. clientSink is piped to `res` with { end: false } so we
    // control when `res` ends. A client disconnect is still propagated back to
    // the upstream: res 'close' destroys clientSink, which errors the pipeline
    // and tears down `upRes` (same teardown guarantee as piping to res directly).
    const clientSink = new PassThrough();
    clientSink.pipe(res, { end: false });
    const onClientClose = () => {
      if (!clientSink.destroyed)
        clientSink.destroy(new Error("client disconnected"));
    };
    res.on("close", onClientClose);

    const stages = [headTap, usageObserver, ...streamStages, ping].filter(
      Boolean,
    ) as NodeJS.ReadWriteStream[];
    streamPipeline([upRes, ...stages, clientSink], (err) => {
      res.off("close", onClientClose);
      if (!err) {
        settle(null);
        try {
          if (!res.writableEnded) res.end();
        } catch {
          /* noop */
        }
        return;
      }
      const e = err as NodeJS.ErrnoException;
      // ERR_STREAM_PREMATURE_CLOSE covers BOTH a client disconnect and an
      // upstream that closed mid-stream — same code, opposite meaning. Use the
      // CLIENT's writable state to tell them apart: if the client is still
      // writable, the UPSTREAM died and the client is waiting, so surface a
      // terminal SSE `event: error` (headers are already 200; we can't change the
      // status, but the client learns the stream ended abnormally instead of
      // hanging). If the client is gone, it's a routine abort — nothing to write.
      const clientGone =
        res.writableEnded ||
        (res as { destroyed?: boolean }).destroyed === true;
      const premature = e.code === "ERR_STREAM_PREMATURE_CLOSE";
      const routineAbort = premature && clientGone;
      if (!routineAbort) {
        this.logger.warn("stream_pipeline_error", { err: e.message });
      }
      if (!clientGone) {
        try {
          res.write(
            `event: error\ndata: ${JSON.stringify({
              type: "error",
              error: { type: "upstream_error", message: e.message },
            })}\n\n`,
          );
        } catch {
          /* client went away between the check and the write */
        }
      }
      // Always settle: the reservation must be reversed and the partial usage
      // observed so far attributed. Bytes already streamed are real usage.
      settle(routineAbort ? "client disconnected" : e.message);
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

    // Run the response through its ordered transform stages. Thinking extraction
    // is now the FIRST stage (a provider-format-tagged default, placed pre-bridge
    // by buildTransformPlan), so it reads provider-native fields before the
    // format bridge — then the bridge (provider->client) and any custom stages.
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
    const isSse = ct.includes("text/event-stream");
    const ping =
      isSse && this.ssePingInterval > 0
        ? new SsePingKeepAlive({ interval: this.ssePingInterval })
        : null;

    // For an SSE passthrough (a native event-stream provider we forward without
    // conversion), mirror streamConvert's robustness: prime a ping on connect and
    // surface a mid-stream upstream failure as a terminal `event: error` instead
    // of a silent truncation. To emit after the pipeline tears down we keep `res`
    // OUT of the destroy chain via a PassThrough sink piped with { end: false };
    // a res 'close' propagates a client abort back to the upstream. Non-SSE bodies
    // (plain proxied responses) keep the simple direct pipe — there's no SSE error
    // frame to send, and a raw truncation is the correct passthrough behavior.
    if (!isSse) {
      streamPipeline([upRes, res], (err) => {
        if (!err) return;
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "ERR_STREAM_PREMATURE_CLOSE")
          this.logger.warn("pipe_stream_error", { err: e.message });
        try {
          if (!res.writableEnded) res.end();
        } catch {
          /* noop */
        }
      });
      return;
    }

    if (ping) {
      try {
        res.write(": ping\n\n");
      } catch {
        /* client already gone */
      }
    }
    const clientSink = new PassThrough();
    clientSink.pipe(res, { end: false });
    const onClientClose = () => {
      if (!clientSink.destroyed)
        clientSink.destroy(new Error("client disconnected"));
    };
    res.on("close", onClientClose);

    const stages = (ping ? [ping] : []) as NodeJS.ReadWriteStream[];
    streamPipeline([upRes, ...stages, clientSink], (err) => {
      res.off("close", onClientClose);
      if (!err) {
        try {
          if (!res.writableEnded) res.end();
        } catch {
          /* noop */
        }
        return;
      }
      const e = err as NodeJS.ErrnoException;
      const clientGone =
        res.writableEnded ||
        (res as { destroyed?: boolean }).destroyed === true;
      const routineAbort =
        e.code === "ERR_STREAM_PREMATURE_CLOSE" && clientGone;
      if (!routineAbort)
        this.logger.warn("pipe_stream_error", { err: e.message });
      if (!clientGone) {
        try {
          res.write(
            `event: error\ndata: ${JSON.stringify({
              type: "error",
              error: { type: "upstream_error", message: e.message },
            })}\n\n`,
          );
        } catch {
          /* client went away between the check and the write */
        }
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
          ctx,
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
    ctx: ForwardContext,
    provider: Provider,
    upstreamModel: string,
    route: Route,
    messagesBody: Record<string, unknown>,
  ): Promise<
    | { ok: true; body: Record<string, unknown>; usage: StreamUsageLike }
    | { ok: false; status: number; reason: string; retryable: boolean }
  > {
    // Health-aware key pick for the (non-streaming) web-tool turn. Each turn is
    // a fresh selection so a rate-limited/auth-failed key is skipped. Picked up
    // front so the builder sees the selected key.
    const pick = this.keyHealth.select(provider, upstreamModel, new Set());
    const key = pick?.key ?? null;

    // Convert Messages -> provider format (via the ordered request stages), force
    // non-streaming, stamp model, then let the adapter build the final request.
    // Fresh per-attempt ctx so a request hook's URL/header rewrites don't leak.
    const attemptCtx: TransformCtx = {
      ...route.xctx,
      headerOverrides: undefined,
      urlOverride: undefined,
    };
    let serialized: string;
    let upstreamUrl: URL;
    let headers: Record<string, string>;
    try {
      const converted = applyBodyTransforms(
        route.request,
        { ...messagesBody },
        attemptCtx,
        this.stageApplyLogger(ctx, "req"),
      );
      converted.model = upstreamModel;
      delete converted.stream;

      const defaultUrl =
        attemptCtx.urlOverride ??
        buildUpstreamUrl(provider, route.forwardPath).toString();
      const defaultHeaders = this.buildHeaders(
        req,
        provider,
        key,
        attemptCtx.headerOverrides,
      );
      const built = route.adapter.buildFor(route.providerFmt, {
        provider,
        model: upstreamModel,
        body: converted,
        apiKey: key,
        clientFmt: route.clientFmt,
        providerFmt: route.providerFmt,
        endpointKind: route.endpointKind,
        forwardPath: route.forwardPath,
        baseUrl: provider.baseUrl,
        basePath: provider.basePath,
        resolve: makeResolve(provider, route.forwardPath),
        url: defaultUrl,
        headers: defaultHeaders,
      });
      delete built.body.stream;
      serialized = JSON.stringify(built.body);
      upstreamUrl = new URL(built.url);
      headers = {
        ...built.headers,
        "content-length": String(Buffer.byteLength(serialized)),
      };
    } catch (err) {
      return {
        ok: false,
        status: 500,
        reason: `request build failed: ${(err as Error).message}`,
        retryable: false,
      };
    }

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
    // Thinking extraction is the first response stage (a pre-bridge, provider-
    // format-tagged default), so route.response handles it before the bridge.
    let messages: Record<string, unknown> = parsed;
    try {
      messages = applyBodyTransforms(
        route.response,
        parsed,
        route.xctx,
        this.stageApplyLogger(ctx, "resp"),
      );
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
    // The loop works in Anthropic Messages shape internally (it inspects
    // tool_use blocks). A Chat-format client sends a chat-shaped body, so convert
    // it here — the seam the loop's contract expects ("if the client spoke
    // chat/responses, the body is handed to us in Messages shape"). The loop
    // still emits back in the client's own format (it keys off the client path).
    if (pathFmt(ctx.clientPath) === "chat") {
      try {
        ctx = { ...ctx, requestBody: chatRequestToMessages(ctx.requestBody) };
      } catch (err) {
        this.logger.warn("web_tool_normalize_failed", {
          err: (err as Error).message,
        });
        // Fall through with the original body; detectWebTools still works on it.
      }
    }
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

  // Compose the DEFAULT header set handed to the adapter's build phase: client
  // header passthrough + host + auth (from the selected key) + extraHeaders. The
  // body isn't final until the builder runs, so content-length is set by the
  // caller after serialization, not here. `overrides` are the request hook's
  // per-attempt header edits (string sets/replaces, null deletes).
  private buildHeaders(
    req: Request,
    provider: Provider,
    key: string | null,
    overrides?: Record<string, string | null>,
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
    applyAuthHeaders(out, provider.authScheme, key);
    for (const [k, v] of Object.entries(provider.extraHeaders || {}))
      out[k] = v;
    if (!out["content-type"]) out["content-type"] = "application/json";
    if (!out["accept"]) out["accept"] = "application/json";
    // Request-hook per-attempt overrides last: a string sets/replaces, null deletes.
    if (overrides) {
      for (const [k, v] of Object.entries(overrides)) {
        if (v === null) delete out[k];
        else out[k] = v;
      }
    }
    return out;
  }
}

// Format conversion tables + thinking helpers live in formats/pipeline.ts;
// pure response-path helpers (safeCaptureResponse, shortId, header filters,
// sleep) live in ./engine-support/utils (imported above).
