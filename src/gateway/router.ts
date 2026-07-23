// Gateway HTTP router.
//
// Assembles the Express middleware stack for the /v1 LLM API surface and wires
// the final proxied requests into the multi-provider forwarding engine. (The
// format *transform* pipeline is a separate concern — see formats/pipeline.ts.)
//
//   request log -> body parser -> client-key auth -> model listings ->
//   model guard -> usage enforcement -> prefill fix ->
//   forwarding engine (which applies the transform pipeline)

import express, { type Express, type Request } from "express";
import type { Database as DB } from "better-sqlite3";
import type { Logger } from "../logger";
import type { ApiKey, Model } from "../types";
import { ModelRegistry } from "./registry";
import { ForwardingEngine, type ForwardContext } from "./engine";
import { detectClient } from "./client-detect";
import { ThinkingConverter } from "../formats/thinking";
import { countInputTokens, readMaxOutputTokens } from "../formats/tokens";
import { sha256 } from "../config";
import {
  countApiKeys,
  getApiKeyByHash,
  getAnyApiKeyByHash,
  touchLastUsed,
} from "../repo/api-keys";
import { addUsage, getUsage, nextUtcMidnight } from "../repo/usage";
import { getSetting } from "../repo/settings";
import type { KeyPick } from "./key-health";

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

export class GatewayRouter {
  readonly registry: ModelRegistry;
  private readonly engine: ForwardingEngine;

  constructor(
    private readonly db: DB,
    private readonly logger: Logger,
    ssePingInterval: number,
  ) {
    this.registry = new ModelRegistry(db);
    this.engine = new ForwardingEngine(
      db,
      logger,
      new ThinkingConverter(),
      ssePingInterval,
    );
  }

  reload(): void {
    this.registry.reload();
  }

  clearAllRateLimits(): {
    keysCleared: number;
    modelCooldownsCleared: number;
  } {
    return this.engine.clearAllRateLimits();
  }

  clearAllModelKeyPairs(): {
    stickyCleared: number;
    affinityCleared: number;
    classAffinityCleared: number;
    creditProvenCleared: number;
  } {
    return this.engine.clearAllModelKeyPairs();
  }

  // Health-aware key pick for the admin "Test connection" probe — see
  // ForwardingEngine.pickKeyForTest. Exposes just this one capability rather
  // than the whole engine, so the admin routes get the live rotation/health
  // state without reaching into forwarding internals.
  pickKeyForTest(
    providerId: string,
    keys: string[],
    model: string | null,
  ): KeyPick | null {
    return this.engine.pickKeyForTest(providerId, keys, model);
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
      if (countApiKeys(this.db) === 0) return next(); // no gateway keys configured -> open
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
      const hash = sha256(provided);
      const apiKey = getApiKeyByHash(this.db, hash);
      if (!apiKey) {
        const known = getAnyApiKeyByHash(this.db, hash);
        if (known && !known.enabled) {
          const message =
            getSetting<string>(this.db, "disabledApiKeyMessage") ||
            "Your API key was revoked. Please contact your gateway's administrator for help.";
          this.logger.warn("auth_rejected_disabled", {
            path: req.originalUrl,
            apiKeyId: known.id,
          });
          return res.status(401).json({
            error: { type: "authentication_error", message },
          });
        }
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

    // --- per-key usage enforcement ---
    app.use("/v1", (req, res, next) => {
      if (req.method !== "POST") return next();
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== "object") return next();

      const gw = req as GatewayRequest;
      const model = gw.__resolved;
      const settings = this.registry.getSettings();
      const inputTokens = countInputTokens(body, req.originalUrl || req.url);
      gw.__inputTokens = inputTokens;

      // Per-key daily quota + optimistic reservation.
      const apiKey = gw.__apiKey;
      if (apiKey) {
        const maxOut =
          readMaxOutputTokens(body) ??
          model?.maxOutputTokens ??
          settings.defaultMaxOutputTokens ??
          0;
        const projected = inputTokens + maxOut;

        // Quota read + optimistic reservation are raw DB ops. A transient DB
        // error here must not 500 the request via Express's default handler —
        // let the request proceed (the engine settles usage when it completes).
        try {
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
              // Every 429 the gateway returns carries a Retry-After so clients
              // back off precisely — here, seconds until the daily quota resets
              // at UTC midnight (floor 1s).
              res.setHeader(
                "Retry-After",
                String(
                  Math.max(
                    1,
                    Math.ceil((resetsAt.getTime() - Date.now()) / 1000),
                  ),
                ),
              );
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
        } catch (err) {
          this.logger.warn("quota_check_failed", {
            err: (err as Error).message,
          });
        }
      }

      next();
    });

    // NOTE: the Claude 4.6+ prefill fix used to live here as middleware, but it
    // ran on the CLIENT body before format conversion and was keyed on the alias.
    // It now runs as an Anthropic provider-adapter request hook
    // (formats/anthropic/hooks/stack.ts), on the final Messages body keyed on the
    // upstream model — so it fires correctly for native /v1/messages, converted
    // chat->messages, and the web-tool loop, and never mis-fires on a
    // messages->chat hop (OpenAI needs no prefill).

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
      const settings = this.registry.getSettings();
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
        debug: settings.debugLogging === true,
        webTools: {
          enabled: settings.webToolsEnabled === true,
          provider: settings.webToolsProvider || "firecrawl",
          baseUrl: settings.webProviderBaseUrl || "",
          apiKey: settings.webProviderApiKey || "",
        },
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
