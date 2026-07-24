// DB-driven model registry: exposed-id shaping, model resolution, and the
// OpenAI / Anthropic model-list responses.
//
// Two prefix layers (carried over from the legacy gateway) are applied when
// listing models and reversed when resolving an incoming model name:
//   1. modelPrefix  — global namespace applied to ALL ids.
//   2. exposePrefix — prepended to every alias UNLESS it starts with one of
//                     exposeExempt (e.g. 'claude'). Default 'anthropic/' so
//                     non-Claude models show up in Claude Code.
//
// State is read from SQLite and cached in memory; call reload() after any
// admin mutation (the admin routes do this) so the gateway serves fresh data
// without a restart.

import type { Database as DB } from "better-sqlite3";
import { stockAnthropicModel } from "../formats/anthropic/stock-models";
import { listModels } from "../repo/models";
import { getSettings } from "../repo/settings";
import {
  DEFAULT_CAPABILITIES,
  type Model,
  type ModelCapabilities,
  type Settings,
} from "../types";

export interface Resolved {
  model?: Model;
  error?: 404;
}

// OpenRouter-compatible model entry (superset of the stock OpenAI shape).
// Optional/unknown OpenRouter fields are omitted rather than faked.
export interface OpenAIModelEntry {
  id: string;
  object: "model";
  canonical_slug: string;
  name: string;
  created: number;
  owned_by: string;
  context_length: number;
  architecture: {
    modality: string;
    input_modalities: string[];
    output_modalities: string[];
    tokenizer: string;
    instruct_type: null;
  };
  pricing: {
    prompt: string;
    completion: string;
  };
  top_provider: {
    context_length: number;
    max_completion_tokens: number;
    is_moderated: boolean;
  };
  per_request_limits: null;
  supported_parameters: string[];
  reasoning?: {
    mandatory: boolean;
    default_enabled: boolean;
    supported_efforts: string[];
    default_effort: string;
  };
}

export interface OpenAIListModelResponse {
  object: "list";
  data: OpenAIModelEntry[];
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
  private models: Model[] = [];
  private settings: Settings;

  constructor(private readonly db: DB) {
    this.settings = getSettings(db);
    this.reload();
  }

  reload(): void {
    this.settings = getSettings(this.db);
    this.models = listModels(this.db, false); // enabled only
  }

  getSettings(): Settings {
    return this.settings;
  }

  private isExempt(alias: string): boolean {
    return (this.settings.exposeExempt || []).some((p) => alias.startsWith(p));
  }

  exposedId(alias: string): string {
    const exposePrefix = this.settings.exposePrefix || "";
    const base =
      exposePrefix && !this.isExempt(alias) ? exposePrefix + alias : alias;
    return (this.settings.modelPrefix || "") + base;
  }

  aliasFromExposed(id: string): string {
    let s = id;
    const p = this.settings.modelPrefix || "";
    if (p && s.startsWith(p)) s = s.slice(p.length);
    const ep = this.settings.exposePrefix || "";
    if (ep && s.startsWith(ep)) s = s.slice(ep.length);
    return s;
  }

  // Resolve a client-supplied model id to the full Model (with its fallback
  // chain). Returns { error: 404 } when unknown/disabled, unless allowUnknown
  // is set, in which case an anonymous pass-through model is synthesized.
  resolveModel(clientModel: string): Resolved {
    if (typeof clientModel !== "string" || clientModel === "") {
      return { error: 404 };
    }
    const alias = this.aliasFromExposed(clientModel);
    const model = this.models.find((m) => m.alias === alias);
    if (model) return { model };
    if (this.settings.allowUnknown) {
      // Forward verbatim to a single-link chain (no provider known yet — the
      // engine will treat the raw name as the upstream model for every enabled
      // provider that has no opinion).
      return {
        model: {
          id: "unknown",
          alias,
          displayName: null,
          contextWindow: null,
          maxOutputTokens: null,
          enabled: true,
          responsesNative: false,
          type: "openai",
          capabilities: DEFAULT_CAPABILITIES,
          capabilitiesLocked: false,
          providers: [],
          createdAt: "",
          updatedAt: "",
          pricing: null,
        },
      };
    }
    return { error: 404 };
  }

  // Look up a model by client id (convenience for the responses-bridge flag).
  modelFor(clientModel: string): Model | undefined {
    const r = this.resolveModel(clientModel);
    return r.model;
  }

  openAIEntry(m: Model): OpenAIModelEntry {
    const caps = m.capabilities || DEFAULT_CAPABILITIES;
    const contextLength = m.contextWindow || 200000;
    const maxCompletion =
      m.maxOutputTokens ?? this.settings.defaultMaxOutputTokens;
    const inputModalities = ["text"];
    if (caps.image_input?.supported) inputModalities.push("image");
    if (caps.pdf_input?.supported) inputModalities.push("file");

    const supportedParameters = [
      "max_tokens",
      "stop",
      "temperature",
      "tool_choice",
      "tools",
      "top_p",
    ];
    if (caps.structured_outputs?.supported)
      supportedParameters.push("structured_outputs");

    const entry: OpenAIModelEntry = {
      id: this.exposedId(m.alias),
      object: "model",
      canonical_slug: m.alias,
      name: m.displayName || m.alias,
      created: Math.floor(new Date(m.createdAt || Date.now()).getTime() / 1000),
      owned_by: "llm-gateway",
      context_length: contextLength,
      architecture: {
        modality: `${inputModalities.join("+")}->text`,
        input_modalities: inputModalities,
        output_modalities: ["text"],
        tokenizer: "Other",
        instruct_type: null,
      },
      pricing: { prompt: "0", completion: "0" },
      top_provider: {
        context_length: contextLength,
        max_completion_tokens: maxCompletion,
        is_moderated: false,
      },
      per_request_limits: null,
      supported_parameters: supportedParameters,
    };

    if (caps.thinking?.supported) {
      supportedParameters.push("include_reasoning", "reasoning");
      supportedParameters.sort();
      const efforts = caps.effort?.supported
        ? (["low", "medium", "high", "xhigh", "max"] as const).filter(
            (e) => caps.effort[e]?.supported,
          )
        : [];
      entry.reasoning = {
        mandatory: false,
        default_enabled: caps.thinking.types?.adaptive?.supported ?? false,
        supported_efforts: [...efforts, "none"],
        default_effort: efforts.includes("high") ? "high" : "none",
      };
    } else {
      supportedParameters.sort();
    }

    return entry;
  }

  listOpenAI(): OpenAIListModelResponse {
    return {
      object: "list",
      data: this.models.map((m) => this.openAIEntry(m)),
    };
  }

  listAnthropic(): AnthropicListModelResponse {
    const data = this.models.map((m) => {
      // Claude models get the stock Anthropic listing entry (real display
      // name, release date, limits, capabilities) so Anthropic clients see
      // exactly what the upstream API would return.
      const stock = stockAnthropicModel(m.alias);
      if (stock) return { ...stock, id: this.exposedId(m.alias) };
      return {
        id: this.exposedId(m.alias),
        type: "model" as const,
        display_name: m.displayName || m.alias,
        created_at: new Date().toISOString(),
        max_input_tokens: m.contextWindow || 200000,
        max_tokens: m.maxOutputTokens ?? this.settings.defaultMaxOutputTokens,
        capabilities: m.capabilities || DEFAULT_CAPABILITIES,
      };
    });
    return {
      data,
      has_more: false,
      first_id: data[0] ? data[0].id : null,
      last_id: data[data.length - 1] ? data[data.length - 1].id : null,
    };
  }

  // All enabled provider ids that appear in some model's chain — used by the
  // engine for allowUnknown pass-through (try every active provider).
  enabledProviderIds(): string[] {
    const ids = new Set<string>();
    for (const m of this.models)
      for (const l of m.providers) if (l.enabled) ids.add(l.providerId);
    return [...ids];
  }
}
