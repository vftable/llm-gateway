// Exposed-id shaping, model resolution, and listings.
//
// Two layers of prefixing, applied when listing models and reversed when
// resolving an incoming model name:
//
//   1. `prefix`         — optional global namespace, applied to ALL ids
//                         (e.g. `gw-` -> `gw-anthropic/gpt-5`).
//   2. `exposePrefix`   — prepended to every alias UNLESS the alias starts
//                         with one of `exposeExempt` (e.g. `claude`).
//                         Default `anthropic/` so non-Claude models show up
//                         in Claude Code with an Anthropic-style id.
//
// So with defaults: `gpt-5` -> `anthropic/gpt-5`, `claude-opus-4.1` -> `claude-opus-4.1`.

import type {
  GatewayConfig,
  ModelMapping,
  ModelsConfig,
  ModelCapabilities,
} from "./config";
import { DEFAULT_CAPABILITIES, DEFAULT_MAX_OUTPUT_TOKENS } from "./config";

export interface ResolvedModel {
  upstream?: string;
  error?: 403 | 404;
}

export interface ModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  display_name?: string;
  context_window?: number;
  max_output_tokens?: number;
}

export interface OpenAIListModelResponse {
  object: "list";
  data: ModelInfo[];
}

export interface AnthropicListModelResponse {
  data: Array<{
    id: string;
    type: "model";
    display_name: string;
    created_at: string;
    max_input_tokens: number;
    max_tokens: number;
    capabilities: ModelCapabilities;
  }>;
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}

export class ModelRegistry {
  constructor(private readonly config: ModelsConfig) {}

  private isExempt(alias: string): boolean {
    const exempt = this.config.exposeExempt || [];
    return exempt.some((p) => alias.startsWith(p));
  }

  // alias  ->  id shown to clients (/<v1/models> and what they send back)
  exposedId(alias: string): string {
    const exposePrefix = this.config.exposePrefix || "";
    const base =
      exposePrefix && !this.isExempt(alias) ? exposePrefix + alias : alias;
    return (this.config.prefix || "") + base;
  }

  // id from a client  ->  alias looked up in `mappings`
  aliasFromExposed(id: string): string {
    let s = id;
    const p = this.config.prefix || "";
    if (p && s.startsWith(p)) s = s.slice(p.length);
    const ep = this.config.exposePrefix || "";
    if (ep && s.startsWith(ep)) s = s.slice(ep.length);
    return s;
  }

  // Resolve a client-supplied model id to an upstream model id.
  resolveUpstream(clientModel: string): ResolvedModel {
    if (typeof clientModel !== "string" || clientModel === "") {
      return { error: 404 };
    }

    // Block by raw upstream id (paranoia: someone bypassing the alias).
    if (this.config.restricted.includes(clientModel)) return { error: 403 };

    // Block by alias too.
    const alias = this.aliasFromExposed(clientModel);
    if (this.config.restricted.includes(alias)) return { error: 403 };

    const mapping = this.config.mappings[alias];
    if (mapping) {
      if (mapping.enabled === false) return { error: 404 };
      return { upstream: mapping.upstream };
    }

    if (this.config.allowUnknown) {
      // Forward unmapped names verbatim.
      return { upstream: clientModel };
    }
    return { error: 404 };
  }

  // Look up a model mapping by client-supplied id (or undefined if unknown /
  // not enabled). Used by the /v1/responses bridge to read per-model flags.
  mappingFor(clientModel: string): ModelMapping | undefined {
    if (typeof clientModel !== "string" || clientModel === "") return undefined;
    const alias = this.aliasFromExposed(clientModel);
    const mapping = this.config.mappings[alias];
    if (!mapping || mapping.enabled === false) return undefined;
    return mapping;
  }

  // True when the model's upstream speaks /v1/responses natively (mapping has
  // `responses: true`). When false, the gateway bridges /v1/responses requests
  // to /v1/chat/completions upstream.
  usesResponsesEndpoint(clientModel: string): boolean {
    const m = this.mappingFor(clientModel);
    return !!(m && m.responses === true);
  }

  listModels(): ModelInfo[] {
    const created = Math.floor(Date.now() / 1000);
    return Object.entries(this.config.mappings)
      .filter(([, m]) => m.enabled !== false)
      .map(([alias, mapping]) => {
        const m: ModelInfo = {
          id: this.exposedId(alias),
          object: "model",
          created,
          owned_by: "llm-gateway",
        };
        if (mapping.displayName) m.display_name = mapping.displayName;
        if (mapping.contextWindow) m.context_window = mapping.contextWindow;
        const maxTokens =
          mapping.maxOutputTokens ||
          this.config.defaultMaxOutputTokens ||
          DEFAULT_MAX_OUTPUT_TOKENS;
        m.max_output_tokens = maxTokens;
        return m;
      });
  }

  // OpenAI-shaped response.
  listOpenAI(): OpenAIListModelResponse {
    return { object: "list", data: this.listModels() };
  }

  // Anthropic-shaped response per https://platform.claude.com/docs/en/api/models/list
  listAnthropic(): AnthropicListModelResponse {
    const data = Object.entries(this.config.mappings)
      .filter(([, m]) => m.enabled !== false)
      .map(([alias, mapping]) => {
        const maxInputTokens = mapping.contextWindow || 200000;
        const maxTokens =
          mapping.maxOutputTokens ||
          this.config.defaultMaxOutputTokens ||
          DEFAULT_MAX_OUTPUT_TOKENS;
        const capabilities = mapping.capabilities || DEFAULT_CAPABILITIES;

        return {
          id: this.exposedId(alias),
          type: "model" as const,
          display_name: mapping.displayName || alias,
          created_at: new Date().toISOString(),
          max_input_tokens: maxInputTokens,
          max_tokens: maxTokens,
          capabilities,
        };
      });
    return {
      data,
      has_more: false,
      first_id: data[0] ? data[0].id : null,
      last_id: data[data.length - 1] ? data[data.length - 1].id : null,
    };
  }
}

// Convenience factory for the common case: build a registry from the full
// gateway config.
export function createModelRegistry(config: GatewayConfig): ModelRegistry {
  return new ModelRegistry(config.models);
}
