// Models repository. Each model is an exposed alias with metadata plus an
// ordered list of provider links (the fallback chain). The chain is stored in
// `model_providers`; this module joins it back so callers always see the full
// Model with its providers[] in priority order.

import type { Database as DB } from "better-sqlite3";
import {
  DEFAULT_CAPABILITIES,
  type Model,
  type ModelCapabilities,
  type ModelProviderLink,
} from "../types";
import { parseJsonObject } from "./json";
import { stockAnthropicModel } from "../formats/anthropic/stock-models";
import { slugify } from "./providers";
import {
  upsertPricing,
  deletePricing,
} from "./pricing";

interface ModelRow {
  id: string;
  alias: string;
  display_name: string | null;
  context_window: number | null;
  max_output_tokens: number | null;
  enabled: number;
  responses_native: number;
  type: string;
  capabilities: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  // LEFT JOINed from model_pricing (absent when no pricing row)
  pricing_prompt_per_1m?: number | null;
  pricing_completion_per_1m?: number | null;
  pricing_cached_per_1m?: number | null;
}

interface LinkRow {
  model_id: string;
  provider_id: string;
  upstream_model: string;
  priority: number;
  enabled: number;
  endpoint: string | null;
  context_window: number | null;
  max_output_tokens: number | null;
}

interface LinkJoinedRow extends LinkRow {
  provider_name: string | null;
  provider_enabled: number;
}

function parseCapabilities(raw: string): ModelCapabilities {
  // Merge over defaults so a partial/legacy stored object still yields a full
  // capability set; a null/malformed value (parseJsonObject → null) → defaults.
  const parsed = parseJsonObject<ModelCapabilities | null>(raw, null);
  return parsed ? { ...DEFAULT_CAPABILITIES, ...parsed } : DEFAULT_CAPABILITIES;
}

function mapModel(r: ModelRow, links: LinkJoinedRow[]): Model {
  // Claude aliases always carry the official Anthropic capabilities (thinking
  // types, effort levels, etc.) — the stock entry is authoritative and takes
  // priority over whatever was saved in the DB, so the admin UI, admin API,
  // and gateway listings can never drift from the real API's metadata.
  const stock = stockAnthropicModel(r.alias);
  return {
    id: r.id,
    alias: r.alias,
    displayName: r.display_name,
    contextWindow: r.context_window,
    maxOutputTokens: r.max_output_tokens,
    enabled: !!r.enabled,
    responsesNative: !!r.responses_native,
    type: r.type,
    capabilities: stock
      ? stock.capabilities
      : parseCapabilities(r.capabilities),
    capabilitiesLocked: !!stock,
    providers: links
      .filter((l) => l.model_id === r.id)
      .sort((a, b) => a.priority - b.priority)
      .map<ModelProviderLink>((l) => ({
        providerId: l.provider_id,
        providerName: l.provider_name,
        upstreamModel: l.upstream_model,
        priority: l.priority,
        enabled: !!l.enabled,
        endpoint: l.endpoint ?? null,
        contextWindow: l.context_window ?? null,
        maxOutputTokens: l.max_output_tokens ?? null,
      })),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    pricing:
      r.pricing_prompt_per_1m !== undefined
        ? {
            promptPer1m: r.pricing_prompt_per_1m ?? null,
            completionPer1m: r.pricing_completion_per_1m ?? null,
            cachedPer1m: r.pricing_cached_per_1m ?? null,
          }
        : null,
  };
}

const LINK_JOIN =
  "SELECT mp.model_id, mp.provider_id, mp.upstream_model, mp.priority, mp.enabled, mp.endpoint, " +
  "mp.context_window, mp.max_output_tokens, " +
  "p.name AS provider_name, p.enabled AS provider_enabled " +
  "FROM model_providers mp LEFT JOIN providers p ON p.id = mp.provider_id";
export function listModels(db: DB, includeDisabled = true): Model[] {
  const rows = db
    .prepare(
      `SELECT m.*, mp.prompt_per_1m AS pricing_prompt_per_1m,
              mp.completion_per_1m AS pricing_completion_per_1m,
              mp.cached_per_1m AS pricing_cached_per_1m
       FROM models m LEFT JOIN model_pricing mp ON mp.alias = m.alias
       ORDER BY m.sort_order, m.alias`,
    )
    .all() as ModelRow[];
  const links = db.prepare(LINK_JOIN).all() as LinkJoinedRow[];
  const all = rows.map((r) => mapModel(r, links));
  return includeDisabled ? all : all.filter((m) => m.enabled);
}

export function getModel(db: DB, id: string): Model | null {
  const row = db
    .prepare(
      `SELECT m.*, mp.prompt_per_1m AS pricing_prompt_per_1m,
              mp.completion_per_1m AS pricing_completion_per_1m,
              mp.cached_per_1m AS pricing_cached_per_1m
       FROM models m LEFT JOIN model_pricing mp ON mp.alias = m.alias
       WHERE m.id = ?`,
    )
    .get(id) as ModelRow | undefined;
  if (!row) return null;
  const links = db
    .prepare(`${LINK_JOIN} WHERE mp.model_id = ?`)
    .all(id) as LinkJoinedRow[];
  return mapModel(row, links);
}

export function getModelByAlias(db: DB, alias: string): Model | null {
  const row = db.prepare("SELECT * FROM models WHERE alias = ?").get(alias) as
    ModelRow | undefined;
  if (!row) return null;
  return getModel(db, row.id);
}

export interface ModelInput {
  id?: string;
  alias: string;
  displayName?: string | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  enabled?: boolean;
  responsesNative?: boolean;
  type?: string;
  capabilities?: ModelCapabilities;
  providers?: Array<{
    providerId: string;
    upstreamModel: string;
    enabled?: boolean;
    endpoint?: string | null;
    contextWindow?: number | null;
    maxOutputTokens?: number | null;
  }>;
  pricing?: {
    promptPer1m?: number | null;
    completionPer1m?: number | null;
    cachedPer1m?: number | null;
  } | null;
}

export function createModel(db: DB, input: ModelInput): Model {
  const now = new Date().toISOString();
  const id = input.id || slugify(input.alias) || `model-${Date.now()}`;
  if (getModel(db, id)) throw new Error(`Model '${id}' already exists`);
  if (getModelByAlias(db, input.alias))
    throw new Error(`Model alias '${input.alias}' is already in use`);

  const tx = db.transaction(() => {
    writeModel(db, "insert", id, now, now, input);

    const providers = input.providers ?? [];
    let priority = 0;
    for (const p of providers) {
      upsertLink(db, id, priority++, p);
    }

    if (input.pricing) {
      upsertPricing(db, {
        alias: input.alias,
        promptPer1m: input.pricing.promptPer1m ?? null,
        completionPer1m: input.pricing.completionPer1m ?? null,
        cachedPer1m: input.pricing.cachedPer1m ?? null,
      });
    }
  });
  tx();
  return getModel(db, id)!;
}

export function updateModel(
  db: DB,
  id: string,
  input: Partial<ModelInput>,
): Model | null {
  const existing = getModel(db, id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const merged: ModelInput = {
    alias: input.alias ?? existing.alias,
    displayName:
      input.displayName !== undefined
        ? input.displayName
        : existing.displayName,
    contextWindow:
      input.contextWindow !== undefined
        ? input.contextWindow
        : existing.contextWindow,
    maxOutputTokens:
      input.maxOutputTokens !== undefined
        ? input.maxOutputTokens
        : existing.maxOutputTokens,
    enabled: input.enabled !== undefined ? input.enabled : existing.enabled,
    responsesNative:
      input.responsesNative !== undefined
        ? input.responsesNative
        : existing.responsesNative,
    type: input.type ?? existing.type,
    capabilities: input.capabilities ?? existing.capabilities,
  };
  // Alias uniqueness check on change.
  if (merged.alias !== existing.alias && getModelByAlias(db, merged.alias)) {
    throw new Error(`Model alias '${merged.alias}' is already in use`);
  }

  const tx = db.transaction(() => {
    writeModel(db, "update", id, existing.createdAt, now, merged);

    if (input.providers) {
      db.prepare("DELETE FROM model_providers WHERE model_id = ?").run(id);
      let priority = 0;
      for (const p of input.providers) {
        upsertLink(db, id, priority++, p);
      }
    }

    // Handle pricing: explicit object = upsert, null = clear, undefined = leave
    if (input.pricing !== undefined) {
      if (input.pricing === null) {
        deletePricing(db, merged.alias);
      } else {
        upsertPricing(db, {
          alias: merged.alias,
          promptPer1m: input.pricing.promptPer1m ?? null,
          completionPer1m: input.pricing.completionPer1m ?? null,
          cachedPer1m: input.pricing.cachedPer1m ?? null,
        });
      }
    }
  });
  tx();
  return getModel(db, id);
}

function writeModel(
  db: DB,
  mode: "insert" | "update",
  id: string,
  createdAt: string,
  updatedAt: string,
  input: ModelInput,
): void {
  // For Claude aliases the official Anthropic capabilities win over whatever
  // the client submitted — keeps the stored row in sync with what mapModel
  // serves.
  const stock = stockAnthropicModel(input.alias);
  const params = {
    id,
    alias: input.alias,
    display_name: input.displayName ?? null,
    context_window: input.contextWindow ?? null,
    max_output_tokens: input.maxOutputTokens ?? null,
    enabled: input.enabled === false ? 0 : 1,
    responses_native: input.responsesNative ? 1 : 0,
    type: input.type ?? "openai",
    capabilities: JSON.stringify(
      stock?.capabilities ?? input.capabilities ?? DEFAULT_CAPABILITIES,
    ),
    sort_order: 0,
    created_at: createdAt,
    updated_at: updatedAt,
  };
  if (mode === "insert") {
    db.prepare(
      `INSERT INTO models
        (id, alias, display_name, context_window, max_output_tokens, enabled,
         responses_native, type, capabilities, sort_order, created_at, updated_at)
       VALUES (@id, @alias, @display_name, @context_window, @max_output_tokens,
         @enabled, @responses_native, @type, @capabilities, @sort_order, @created_at, @updated_at)`,
    ).run(params);
  } else {
    db.prepare(
      `UPDATE models SET
         alias=@alias, display_name=@display_name, context_window=@context_window,
         max_output_tokens=@max_output_tokens, enabled=@enabled,
         responses_native=@responses_native, type=@type, capabilities=@capabilities,
         updated_at=@updated_at
       WHERE id=@id`,
    ).run(params);
  }
}

export type ModelLinkInput = NonNullable<ModelInput["providers"]>[number];
export interface ModelLinkIdentity {
  providerId: string;
  upstreamModel: string;
}
export interface BatchModelLinkOps {
  add?: ModelLinkInput[];
  remove?: ModelLinkIdentity[];
  update?: Array<
    ModelLinkIdentity & {
      enabled?: boolean;
      endpoint?: string | null;
      contextWindow?: number | null;
      maxOutputTokens?: number | null;
    }
  >;
  /** Listed identities move to the front in this exact order. */
  reorder?: ModelLinkIdentity[];
}
export interface BatchModelLinkResult {
  added: number;
  removed: number;
  updated: number;
  reordered: number;
  model: Model;
}

type LinkInput = ModelLinkInput;

function upsertLink(
  db: DB,
  modelId: string,
  priority: number,
  link: LinkInput,
): void {
  db.prepare(
    `INSERT INTO model_providers
       (model_id, provider_id, upstream_model, priority, enabled, endpoint,
        context_window, max_output_tokens)
     VALUES (@model_id, @provider_id, @upstream_model, @priority, @enabled,
        @endpoint, @context_window, @max_output_tokens)
     ON CONFLICT(model_id, provider_id, upstream_model) DO UPDATE SET
       priority=@priority, enabled=@enabled,
       endpoint=@endpoint, context_window=@context_window,
       max_output_tokens=@max_output_tokens`,
  ).run({
    model_id: modelId,
    provider_id: link.providerId,
    upstream_model: link.upstreamModel,
    priority,
    enabled: link.enabled === false ? 0 : 1,
    endpoint: link.endpoint || null,
    context_window: link.contextWindow ?? null,
    max_output_tokens: link.maxOutputTokens ?? null,
  });
}

export function batchModelLinks(
  db: DB,
  modelId: string,
  ops: BatchModelLinkOps,
): BatchModelLinkResult {
  const existingModel = getModel(db, modelId);
  if (!existingModel) throw new Error(`Model '${modelId}' not found`);

  const result = { added: 0, removed: 0, updated: 0, reordered: 0 };
  const identity = (link: ModelLinkIdentity) =>
    `${link.providerId} ${link.upstreamModel}`;

  const tx = db.transaction(() => {
    let current = getModel(db, modelId)!.providers;

    for (const link of ops.add ?? []) {
      if (current.some((row) => identity(row) === identity(link)))
        throw new Error(
          `Model link '${link.providerId}/${link.upstreamModel}' already exists`,
        );
      upsertLink(db, modelId, current.length, link);
      result.added++;
      current = getModel(db, modelId)!.providers;
    }

    for (const link of ops.update ?? []) {
      const saved = current.find((row) => identity(row) === identity(link));
      if (!saved)
        throw new Error(
          `Model link '${link.providerId}/${link.upstreamModel}' not found`,
        );
      upsertLink(db, modelId, saved.priority, {
        providerId: saved.providerId,
        upstreamModel: saved.upstreamModel,
        enabled: link.enabled ?? saved.enabled,
        endpoint: link.endpoint !== undefined ? link.endpoint : saved.endpoint,
        contextWindow:
          link.contextWindow !== undefined
            ? link.contextWindow
            : saved.contextWindow,
        maxOutputTokens:
          link.maxOutputTokens !== undefined
            ? link.maxOutputTokens
            : saved.maxOutputTokens,
      });
      result.updated++;
      current = getModel(db, modelId)!.providers;
    }

    for (const link of ops.remove ?? []) {
      const changes = db
        .prepare(
          `DELETE FROM model_providers
           WHERE model_id = ? AND provider_id = ? AND upstream_model = ?`,
        )
        .run(modelId, link.providerId, link.upstreamModel).changes;
      if (!changes)
        throw new Error(
          `Model link '${link.providerId}/${link.upstreamModel}' not found`,
        );
      result.removed++;
      current = getModel(db, modelId)!.providers;
    }

    if (ops.reorder) {
      const requested = new Set<string>();
      const ordered: typeof current = [];
      for (const link of ops.reorder) {
        const key = identity(link);
        if (requested.has(key))
          throw new Error(`Duplicate reorder link '${key}'`);
        const saved = current.find((row) => identity(row) === key);
        if (!saved)
          throw new Error(
            `Model link '${link.providerId}/${link.upstreamModel}' not found`,
          );
        requested.add(key);
        ordered.push(saved);
      }
      ordered.push(...current.filter((row) => !requested.has(identity(row))));
      const setPriority = db.prepare(
        `UPDATE model_providers SET priority = ?
         WHERE model_id = ? AND provider_id = ? AND upstream_model = ?`,
      );
      ordered.forEach((link, priority) =>
        setPriority.run(priority, modelId, link.providerId, link.upstreamModel),
      );
    } else if ((ops.add?.length ?? 0) + (ops.remove?.length ?? 0) > 0) {
      // Compact priorities after structural edits.
      current = getModel(db, modelId)!.providers;
      const setPriority = db.prepare(
        `UPDATE model_providers SET priority = ?
         WHERE model_id = ? AND provider_id = ? AND upstream_model = ?`,
      );
      current.forEach((link, priority) =>
        setPriority.run(priority, modelId, link.providerId, link.upstreamModel),
      );
    }
  });

  tx();
  return { ...result, model: getModel(db, modelId)! };
}

export function deleteModel(db: DB, id: string): boolean {
  const row = db.prepare("SELECT alias FROM models WHERE id = ?").get(id) as
    | { alias: string }
    | undefined;
  if (!row) return false;
  const tx = db.transaction(() => {
    deletePricing(db, row.alias);
    db.prepare("DELETE FROM models WHERE id = ?").run(id);
  });
  tx();
  return true;
}
