// Ties together the Express app, all middleware, and the gateway's domain
// objects (logger, model registry, proxy). The entry point in `index.ts`
// constructs one of these and calls `start()`.

import express, { type Express } from "express";
import type { Server } from "http";
import type { GatewayConfig } from "./config";
import { Logger } from "./logger";
import { ModelRegistry } from "./models";
import { ThinkingConverter } from "./thinking";
import { ResponsesBridge } from "./responses-bridge";
import { GatewayProxy, type GatewayRequest } from "./proxy";
import { applyPrefillFix } from "./prefill";

export class Gateway {
  readonly app: Express;
  readonly logger: Logger;
  readonly models: ModelRegistry;
  readonly thinking: ThinkingConverter;
  readonly bridge: ResponsesBridge;
  readonly proxy: GatewayProxy;
  private server: Server | null = null;

  constructor(
    private readonly config: GatewayConfig,
    deps?: {
      logger?: Logger;
      models?: ModelRegistry;
      thinking?: ThinkingConverter;
      bridge?: ResponsesBridge;
    },
  ) {
    this.logger = deps?.logger ?? new Logger();
    this.models = deps?.models ?? new ModelRegistry(config.models);
    this.thinking = deps?.thinking ?? new ThinkingConverter();
    this.bridge = deps?.bridge ?? new ResponsesBridge();
    this.proxy = new GatewayProxy(
      config,
      this.logger,
      this.models,
      this.thinking,
      this.bridge,
    );

    this.app = express();
    this.registerProcessHandlers();
    this.registerMiddleware();
  }

  // --- Process-level error handling ---------------------------------------
  // Route Node warnings through our logger. Silence http-proxy's known
  // util._extend deprecation (DEP0060) — it's in upstream code we can't patch.
  private registerProcessHandlers(): void {
    process.on("warning", (w) => {
      const code = (w as Error & { code?: string }).code;
      if (code === "DEP0060" || /util\._extend/.test(w.message || "")) return;
      this.logger.warn("node_warning", { name: w.name, message: w.message });
    });
    process.on("unhandledRejection", (err) => {
      this.logger.error("unhandled_rejection", {
        err: err && (err as Error).stack ? (err as Error).stack : String(err),
      });
    });
    process.on("uncaughtException", (err) => {
      this.logger.error("uncaught_exception", {
        err: err && err.stack ? err.stack : String(err),
      });
      process.exit(1);
    });
  }

  private registerMiddleware(): void {
    // --- Request logger (every request, logs at completion) -----------------
    this.app.use((req, res, next) => {
      const start = process.hrtime.bigint();
      let done = false;
      const finish = (eventNote?: string | null) => () => {
        if (done) return;
        done = true;
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        // If the request was forwarded to upstream, show what model id we
        // actually sent. This makes it obvious from the log line whether a 4xx
        // came from the gateway guard (no annotation) or from upstream.
        const parts: string[] = [];
        const gwReq = req as GatewayRequest;
        if (gwReq.__gatewayResolvedTo) {
          parts.push(`upstream->${gwReq.__gatewayResolvedTo}`);
        }
        if (eventNote) parts.push(eventNote);
        this.logger.request(
          req,
          res,
          ms,
          parts.join(" ") || null,
          req.body as { model?: string } | undefined,
        );
      };
      res.on("finish", finish(null));
      res.on("close", finish(res.writableEnded ? null : "aborted"));
      next();
    });

    // --- Body parser (only the /v1 LLM API surface) -------------------------
    // Large limit for big prompts. Errors are handled by the final error middleware.
    this.app.use("/v1", express.json({ limit: "100mb" }));

    // --- Optional gateway auth ----------------------------------------------
    // Accepts any key in config.gatewayApiKeys (one per user). Empty set = open.
    this.app.use("/v1", (req, res, next) => {
      if (this.config.gatewayApiKeys.size === 0) return next();
      const bearer = (req.header("authorization") || "").replace(
        /^Bearer\s+/i,
        "",
      );
      const provided = bearer || req.header("x-api-key") || "";
      if (this.config.gatewayApiKeys.has(provided)) return next();
      this.logger.warn("auth_rejected", { path: req.originalUrl });
      return res.status(401).json({
        error: { type: "authentication_error", message: "Invalid API key" },
      });
    });

    // --- Model listings ------------------------------------------------------
    // Pick the response shape based on whether the client looks like the
    // Anthropic SDK (sends anthropic-version) or an OpenAI-style client.
    this.app.get("/v1/models", (req, res) => {
      const isAnthropic =
        !!req.header("anthropic-version") || !!req.header("x-api-key");
      res.json(
        isAnthropic ? this.models.listAnthropic() : this.models.listOpenAI(),
      );
    });

    this.app.get("/v1/models/:id", (req, res) => {
      const r = this.models.resolveUpstream(req.params.id);
      if (r.error) {
        return res.status(r.error).json({
          error: {
            type: "not_found",
            message: `Model '${req.params.id}' not found`,
          },
        });
      }
      const alias = this.models.aliasFromExposed(req.params.id);
      const mapping = this.config.models.mappings[alias] || {};
      if (mapping.enabled === false) {
        return res.status(404).json({
          error: {
            type: "not_found",
            message: `Model '${req.params.id}' not found`,
          },
        });
      }
      const m: Record<string, unknown> = {
        id: req.params.id,
        object: "model",
        owned_by: "llm-gateway",
      };
      if (mapping.displayName) m.display_name = mapping.displayName;
      if (mapping.contextWindow) m.context_window = mapping.contextWindow;
      res.json(m);
    });

    // --- Pre-proxy guard: reject restricted/unknown models ------------------
    // Saves a round-trip and gives clean errors instead of upstream 4xx.
    this.app.use("/v1", (req, res, next) => {
      const body = req.body as { model?: unknown } | undefined;
      const model = body && body.model;
      if (typeof model !== "string") return next();

      const r = this.models.resolveUpstream(model);
      const gwReq = req as GatewayRequest;
      gwReq.__gatewayResolved = r; // cache for prepareProxyReq to reuse
      if (r.error === 403) {
        this.logger.warn("restricted_model", { path: req.originalUrl, model });
        return res.status(403).json({
          error: {
            type: "restricted_model",
            message: `Model '${model}' is restricted by the gateway administrator.`,
            source: "gateway",
            requested: model,
          },
        });
      }
      if (r.error === 404) {
        const available = this.models.listModels().map((m) => m.id);
        this.logger.warn("unknown_model", {
          path: req.originalUrl,
          model,
          available_count: available.length,
        });
        return res.status(404).json({
          error: {
            type: "model_not_found",
            message: `Model '${model}' is not exposed by this gateway. Check /v1/models for the list of available ids.`,
            source: "gateway",
            requested: model,
            available,
          },
        });
      }
      next();
    });

    // --- Claude 4.6+ prefill auto-fix ---------------------------------------
    // Anthropic removed assistant-message prefill in Claude 4.6: a request
    // whose final message is an `assistant` turn is rejected. When the
    // resolved model is affected, append a trailing `user` message (with
    // `tool_result` blocks when the assistant turn had `tool_use` blocks) so
    // the request is accepted. Runs after model resolution and before the
    // proxy so the appended message is re-serialized for upstream. Applies to
    // both /v1/messages and /v1/chat/completions.
    this.app.use("/v1", (req, res, next) => {
      const body = req.body as
        | { messages?: unknown; model?: unknown }
        | undefined;
      if (!body || typeof body !== "object") return next();

      const gwReq = req as GatewayRequest;
      const model =
        typeof body.model === "string"
          ? body.model
          : gwReq.__gatewayResolved?.upstream;
      if (typeof model !== "string") return next();

      const result = applyPrefillFix(body, model);
      if (result.appended) {
        this.logger.info("prefill_fix", {
          model,
          count: `${result.before}->${result.after}`,
          tool_ids: result.toolIds.join(",") || null,
        });
      }
      next();
    });

    // --- /v1/responses bridge: route to /v1/chat/completions when upstream
    // lacks native Responses support. Per-model: set `responses: true` on a
    // mapping to pass through unchanged; otherwise the gateway translates
    // request/response shapes between the two APIs.
    //
    // Streaming is bridged: streaming requests are translated to Chat
    // Completions, forwarded upstream, and the SSE stream is converted back
    // to Responses format chunk-by-chunk with no buffering.
    this.app.post("/v1/responses", (req, res, next) => {
      // Body may be absent or non-object for odd clients; let the proxy handle it.
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== "object") return next();

      const model = typeof body.model === "string" ? body.model : null;
      if (!model) return next();

      // Native Responses support — pass through untouched.
      if (this.models.usesResponsesEndpoint(model)) return next();

      // Translate Responses -> Chat Completions, then have the proxy forward
      // to /v1/chat/completions. For streaming, the proxy converts the SSE
      // chunks back to Responses format in real-time.
      const gwReq = req as GatewayRequest;
      try {
        req.body = this.bridge.requestToChatCompletions(body);
        gwReq.__gatewayRewritePath = "/chat/completions";
        gwReq.__gatewayResponsesBridge = true;
        if (body.stream === true) {
          gwReq.__gatewayStreamBridge = true;
          this.logger.info("responses_bridge_stream", { model });
        } else {
          this.logger.info("responses_bridge", { model });
        }
      } catch (err) {
        this.logger.error("responses_bridge_request_failed", {
          model,
          err: err && (err as Error).stack ? (err as Error).stack : String(err),
        });
        return res.status(400).json({
          error: {
            type: "invalid_request_error",
            message: "Gateway could not translate this /v1/responses request",
            source: "gateway",
          },
        });
      }
      next();
    });

    // --- Proxy everything else under /v1 to 9router -------------------------
    // Covers /v1/messages (Anthropic), /v1/chat/completions, /v1/completions,
    // /v1/embeddings, /v1/responses, /v1/messages/count_tokens, etc.
    // Responses (including SSE streams) are piped through untouched.
    this.app.use("/v1", this.proxy.createMiddleware());

    // --- Health -------------------------------------------------------------
    this.app.get("/health", (_req, res) =>
      res.json({ ok: true, upstream: this.config.upstream }),
    );

    // --- 404 catch-all ------------------------------------------------------
    this.app.use((req, res) => {
      res.status(404).json({
        error: {
          type: "not_found",
          message: `Unknown path: ${req.method} ${req.path}`,
        },
      });
    });

    // --- Final error handler (must be 4-arg, registered last) ---------------
    // Turns Express body-parser errors and any uncaught errors into clean JSON.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    this.app.use(
      (
        err: unknown,
        req: express.Request,
        res: express.Response,
        next: express.NextFunction,
      ) => {
        const e = err as {
          type?: string;
          status?: number;
          message?: string;
          stack?: string;
        };
        const isBodyErr =
          e &&
          (e.type === "entity.parse.failed" ||
            e.type === "entity.too.large" ||
            e.type === "entity.verify.failed");

        if (isBodyErr) {
          this.logger.warn("bad_request", {
            path: req.originalUrl,
            type: e!.type,
            err: e!.message,
          });
          if (res.headersSent) return;
          return res.status(e!.status || 400).json({
            error: {
              type: e!.type || "bad_request",
              message: e!.message || "Malformed request body",
            },
          });
        }

        this.logger.error("unhandled_error", {
          path: req.originalUrl,
          err: e && e.stack ? e.stack : String(e),
        });
        if (res.headersSent) return;
        res.status(500).json({
          error: { type: "internal_error", message: "Internal gateway error" },
        });
      },
    );
  }

  start(): Server {
    if (this.server) return this.server;
    const exposedIds = Object.keys(this.config.models.mappings).map((alias) =>
      this.models.exposedId(alias),
    );
    this.logger.info("llm-gateway starting");
    this.logger.info("listening", {
      url: `http://0.0.0.0:${this.config.port}`,
    });
    this.logger.info("upstream", {
      url: this.config.upstream,
      tlsVerify: this.config.upstreamTlsVerify,
    });
    this.logger.info("auth", {
      keys: this.config.gatewayApiKeys.size,
      required: this.config.gatewayApiKeys.size > 0,
    });
    this.logger.info("exposed", {
      count: exposedIds.length,
      models: exposedIds.join(", ") || "(none)",
    });
    if (this.config.models.prefix || this.config.models.exposePrefix) {
      this.logger.info("prefix", {
        prefix: this.config.models.prefix || "(none)",
        exposePrefix: this.config.models.exposePrefix || "(none)",
        exempt: JSON.stringify(this.config.models.exposeExempt || []),
      });
    }
    if (this.config.models.restricted.length) {
      this.logger.warn("restricted", {
        models: this.config.models.restricted.join(", "),
      });
    }
    this.server = this.app.listen(this.config.port);
    return this.server;
  }
}
