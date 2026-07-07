// Gateway request pipeline.
//
// Assembles the Express middleware stack for the /v1 LLM API surface and wires
// the final proxied requests into the multi-provider forwarding engine:
// guard / context-window / per-key quota / prefill / responses-bridge stages,
// DB-driven and multi-provider.
//
//   request log -> body parser -> client-key auth -> model listings ->
//   model guard -> context-window + usage enforcement -> prefill fix ->
//   /v1/responses bridge -> forwarding engine

import express, { type Express, type Request, type Response } from "express";
import type { Database as DB } from "better-sqlite3";
import type { Logger } from "../logger";
import type { ApiKey, Model } from "../shared/types";
import { ModelRegistry } from "./registry";
import { ForwardingEngine, type ForwardContext } from "./engine";
import { detectClient } from "./client-detect";
import { ThinkingConverter } from "../thinking";
import { ResponsesBridge } from "../responses-bridge";
import { applyPrefillFix } from "../prefill";
import { countInputTokens, readMaxOutputTokens } from "../tokens";
import { sha256 } from "../config";
import {
  countEnabledApiKeys,
  getApiKeyByHash,
  touchLastUsed,
} from "../repo/api-keys";
import { addUsage, getUsage, nextUtcMidnight } from "../repo/usage";

export interface GatewayRequest extends Request {
  __apiKey?: ApiKey | null;
  __resolved?: Model | null;
  __alias?: string;
  __inputTokens?: number;
  /** Tokens optimistically debited from the key's daily counter up front
   *  (input estimate + reserved max output). The engine reverses exactly this
   *  after the response settles, then applies the actual usage. */
  __reservedTokens?: number;
  __upstreamPath?: string;
  __responsesBridge?: boolean;
}

export class GatewayPipeline {
  readonly registry: ModelRegistry;
  private readonly engine: ForwardingEngine;

  constructor(
    private readonly db: DB,
    private readonly logger: Logger,
    private readonly ssePingInterval: number,
  ) {
    this.registry = new ModelRegistry(db);
    this.engine = new ForwardingEngine(
      db,
      logger,
      new ThinkingConverter(),
      new ResponsesBridge(),
      ssePingInterval,
    );
  }

  reload(): void {
    this.registry.reload();
  }

  register(app: Express): void {
    // --- per-request logger (logs at completion) ---
    app.use("/v1", (req, res, next) => {
      const start = process.hrtime.bigint();
      let done = false;
      const finish = (note?: string | null) => () => {
        if (done) return;
        done = true;
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        const gw = req as GatewayRequest;
        const parts: string[] = [];
        if (gw.__alias && gw.__resolved) parts.push(`model=${gw.__alias}`);
        if (note) parts.push(note);
        this.logger.request(req, res, ms, parts.join(" ") || null, req.body);
      };
      res.on("finish", finish(null));
      res.on("close", finish(res.writableEnded ? null : "aborted"));
      next();
    });

    app.use("/v1", express.json({ limit: "100mb" }));

    // --- client-key auth ---
    app.use("/v1", (req, res, next) => {
      if (countEnabledApiKeys(this.db) === 0) return next(); // no keys -> open
      const bearer = (req.header("authorization") || "").replace(
        /^Bearer\s+/i,
        "",
      );
      const provided = bearer || req.header("x-api-key") || "";
      if (!provided) {
        return res.status(401).json({
          error: { type: "authentication_error", message: "Missing API key" },
        });
      }
      const apiKey = getApiKeyByHash(this.db, sha256(provided));
      if (!apiKey) {
        this.logger.warn("auth_rejected", { path: req.originalUrl });
        return res.status(401).json({
          error: { type: "authentication_error", message: "Invalid API key" },
        });
      }
      (req as GatewayRequest).__apiKey = apiKey;
      touchLastUsed(this.db, apiKey.id);
      next();
    });

    // --- model listings ---
    app.get("/v1/models", (req, res) => {
      const isAnthropic =
        !!req.header("anthropic-version") || !!req.header("x-api-key");
      res.json(
        isAnthropic
          ? this.registry.listAnthropic()
          : this.registry.listOpenAI(),
      );
    });

    app.get("/v1/models/:id", (req, res) => {
      const r = this.registry.resolveModel(req.params.id);
      if (!r.model) {
        return res.status(404).json({
          error: {
            type: "not_found",
            message: `Model '${req.params.id}' not found`,
          },
        });
      }
      res.json(this.registry.openAIEntry(r.model));
    });

    // --- model guard ---
    app.use("/v1", (req, res, next) => {
      const body = req.body as { model?: unknown } | undefined;
      const model = body && body.model;
      if (typeof model !== "string") return next();
      const r = this.registry.resolveModel(model);
      const gw = req as GatewayRequest;
      gw.__resolved = r.model ?? null;
      gw.__alias = r.model ? r.model.alias : undefined;
      if (r.error === 404) {
        this.logger.warn("unknown_model", { path: req.originalUrl, model });
        return res.status(404).json({
          error: {
            type: "model_not_found",
            message: `Model '${model}' is not exposed by this gateway.`,
            source: "gateway",
            requested: model,
          },
        });
      }
      next();
    });

    // --- context-window + per-key usage enforcement ---
    app.use("/v1", (req, res, next) => {
      if (req.method !== "POST") return next();
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== "object") return next();

      const gw = req as GatewayRequest;
      const model = gw.__resolved;
      const settings = this.registry.getSettings();
      const inputTokens = countInputTokens(body, req.originalUrl || req.url);
      gw.__inputTokens = inputTokens;

      if (model?.contextWindow && model.contextWindow > 0) {
        const maxOut =
          readMaxOutputTokens(body) ??
          model.maxOutputTokens ??
          settings.defaultMaxOutputTokens ??
          0;
        const projected = inputTokens + maxOut;
        if (projected > model.contextWindow) {
          this.logger.warn("context_limit", {
            model: gw.__alias,
            inputTokens,
            maxOut,
            contextWindow: model.contextWindow,
          });
          return res.status(413).json({
            error: {
              type: "context_too_large",
              message: `Request projected at ${projected} tokens exceeds the ${model.contextWindow}-token context window for '${String(body.model)}'.`,
              source: "gateway",
              input_tokens: inputTokens,
              max_output_tokens: maxOut,
              context_window: model.contextWindow,
              projected,
            },
          });
        }
      }

      // Per-key daily quota + optimistic reservation.
      const apiKey = gw.__apiKey;
      if (apiKey) {
        const maxOut =
          readMaxOutputTokens(body) ??
          model?.maxOutputTokens ??
          settings.defaultMaxOutputTokens ??
          0;
        const projected = inputTokens + maxOut;

        // Enforce the daily quota only when the key has one.
        if (apiKey.tokensPerDay && apiKey.tokensPerDay > 0) {
          const used = getUsage(this.db, apiKey.id).tokens;
          if (used + projected > apiKey.tokensPerDay) {
            const resetsAt = nextUtcMidnight();
            this.logger.warn("usage_limit", {
              key: apiKey.id,
              used,
              projected,
              limit: apiKey.tokensPerDay,
            });
            return res.status(429).json({
              error: {
                type: "usage_limit_reached",
                message: `Daily token quota for this key would be exceeded (used ${used}/${apiKey.tokensPerDay}, request needs ~${projected}). Resets at ${resetsAt.toISOString()}.`,
                source: "gateway",
                used,
                limit: apiKey.tokensPerDay,
                projected,
                resets_at: resetsAt.toISOString(),
              },
            });
          }
        }

        // Optimistic reservation. Always applied (even for unlimited keys) so
        // the live counter reflects in-flight requests; the engine reverses
        // exactly __reservedTokens once the real usage is known. Stash the
        // amount so the reversal can't drift from what was debited here.
        if (projected > 0) {
          addUsage(this.db, apiKey.id, projected);
          gw.__reservedTokens = projected;
        }
      }

      next();
    });

    // --- Claude 4.6+ prefill auto-fix ---
    app.use("/v1", (req, res, next) => {
      const body = req.body as
        { messages?: unknown; model?: unknown } | undefined;
      if (!body || typeof body !== "object") return next();
      const gw = req as GatewayRequest;
      const model =
        typeof body.model === "string"
          ? body.model
          : gw.__resolved?.alias || "";
      if (!model) return next();
      const result = applyPrefillFix(body, model);
      if (result.appended) {
        this.logger.info("prefill_fix", {
          model,
          count: `${result.before}->${result.after}`,
        });
      }
      next();
    });

    // --- forwarding engine (everything under /v1, incl. /v1/responses) ---
    // The engine decides per-provider-endpoint whether to convert wire formats
    // (Anthropic Messages <-> OpenAI Chat <-> OpenAI Responses), so we hand it
    // the original client body + path untouched.
    app.use("/v1", (req, res) => {
      const gw = req as GatewayRequest;
      const body =
        req.body && typeof req.body === "object"
          ? (req.body as Record<string, unknown>)
          : {};
      const ctx: ForwardContext = {
        clientPath: req.originalUrl || req.url,
        requestBody: body,
        resolvedModel: gw.__resolved ?? null,
        alias: gw.__alias ?? (typeof body.model === "string" ? body.model : ""),
        apiKey: gw.__apiKey ?? null,
        inputTokens: gw.__inputTokens ?? 0,
        reservedTokens: gw.__reservedTokens ?? 0,
        isStream: body.stream === true,
        client: detectClient(req),
      };
      // Don't let an async rejection escape Express's sync handler.
      this.engine.forward(req, res, ctx).catch((err) => {
        this.logger.error("engine_unhandled", { err: (err as Error).message });
        if (!res.headersSent) {
          res.status(500).json({
            error: { type: "internal_error", message: "Gateway error" },
          });
        }
      });
    });
  }
}
