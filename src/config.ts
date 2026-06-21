// Typed config schema + loader. Reads ./config.json (project root), layers
// defaults, normalizes the various shorthand/legacy fields, and strips the
// `_*_comment` annotation fields so they don't leak into runtime config.

import fs from "fs";
import path from "path";

export interface ModelMapping {
  upstream: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  enabled?: boolean;
  /** true when the upstream speaks /v1/responses natively; otherwise the gateway bridges. */
  responses?: boolean;
  /** Override capabilities. If not set, defaults to full Claude-compatible capabilities. */
  capabilities?: ModelCapabilities;
}

export interface CapabilitySupport {
  supported: boolean;
}

export interface ThinkingCapability {
  supported: boolean;
  types: {
    adaptive: CapabilitySupport;
    enabled: CapabilitySupport;
  };
}

export interface EffortCapability {
  supported: boolean;
  low: CapabilitySupport;
  medium: CapabilitySupport;
  high: CapabilitySupport;
  xhigh: CapabilitySupport;
  max: CapabilitySupport;
}

export interface ModelCapabilities {
  batch: CapabilitySupport;
  citations: CapabilitySupport;
  code_execution: CapabilitySupport;
  image_input: CapabilitySupport;
  pdf_input: CapabilitySupport;
  structured_outputs: CapabilitySupport;
  thinking: ThinkingCapability;
  effort: EffortCapability;
}

export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  batch: { supported: true },
  citations: { supported: false },
  code_execution: { supported: false },
  image_input: { supported: false },
  pdf_input: { supported: false },
  structured_outputs: { supported: true },
  thinking: {
    supported: true,
    types: {
      adaptive: { supported: true },
      enabled: { supported: true },
    },
  },
  effort: {
    supported: true,
    low: { supported: true },
    medium: { supported: true },
    high: { supported: true },
    xhigh: { supported: true },
    max: { supported: true },
  },
};

export const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

export interface ModelsConfig {
  prefix: string;
  exposePrefix: string;
  exposeExempt: string[];
  mappings: Record<string, ModelMapping>;
  restricted: string[];
  allowUnknown: boolean;
  defaultMaxOutputTokens?: number;
}

// Per-key configuration. Currently only carries an optional daily token
// quota. Keys present in the map without a KeyConfig (undefined value) are
// still valid for auth — they just have no limit.
export interface KeyConfig {
  /** Max tokens (input + output) the key may consume per UTC day. undefined = unlimited. */
  tokensPerDay?: number;
}

export interface GatewayConfig {
  port: number;
  upstream: string;
  upstreamApiKey: string;
  /**
   * Accepted client keys. Map preserves insertion order.
   *   - Empty map = auth disabled (open proxy).
   *   - Keys with undefined KeyConfig = valid key, no quota.
   *   - Keys with { tokensPerDay } = valid key, daily token quota enforced.
   */
  gatewayApiKeys: Map<string, KeyConfig>;
  /** Path to the JSON file used for per-key usage persistence. Default: ./usage.json. */
  usageFile?: string;
  upstreamTlsVerify: boolean;
  models: ModelsConfig;
  /** Interval in milliseconds for SSE ping keep-alive. 0 = disabled. Default: 30000 (30s). */
  ssePingInterval?: number;
}

const DEFAULTS: GatewayConfig = {
  port: 8787,
  upstream: "http://127.0.0.1:3000",
  upstreamApiKey: "",
  gatewayApiKeys: new Map<string, KeyConfig>(),
  usageFile: undefined,
  upstreamTlsVerify: true,
  models: {
    prefix: "",
    exposePrefix: "anthropic/",
    exposeExempt: ["claude"],
    mappings: {},
    restricted: [],
    allowUnknown: false,
  },
};

interface RawConfig {
  port?: number;
  upstream?: string;
  upstreamApiKey?: string;
  gatewayApiKey?: string;
  gatewayApiKeys?: string | string[] | Record<string, KeyConfig | null>;
  usageFile?: string;
  upstreamTlsVerify?: boolean;
  models?: {
    prefix?: string;
    exposePrefix?: string;
    exposeExempt?: string[];
    mappings?: Record<string, string | ModelMapping>;
    restricted?: string[];
    allowUnknown?: boolean;
    defaultMaxOutputTokens?: number;
  };
}

// Strip any `_*_comment` fields so they don't leak into the runtime config.
function stripComments<T>(obj: T): T {
  if (Array.isArray(obj)) return obj.map(stripComments) as unknown as T;
  if (obj && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>)
        .filter(([k]) => !/^_.*_comment$/.test(k))
        .map(([k, v]) => [k, stripComments(v)]),
    ) as unknown as T;
  }
  return obj;
}

export function loadConfig(configPath?: string): GatewayConfig {
  const CONFIG_PATH = configPath || path.join(__dirname, "..", "config.json");

  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `config.json not found at ${CONFIG_PATH}. ` +
          `Copy config.example.json to config.json and edit it.`,
      );
    }
    throw err;
  }

  // Tolerate a leading UTF-8 BOM (common on Windows / Notepad saves).
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  let parsed: RawConfig;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${(err as Error).message}`);
  }

  if (!parsed.upstream || typeof parsed.upstream !== "string") {
    throw new Error('config.json: "upstream" is required');
  }

  parsed = stripComments(parsed);

  // Layer defaults on top of user values.
  const merged: GatewayConfig = {
    ...DEFAULTS,
    ...(parsed as Partial<GatewayConfig>),
  };

  const modelsIn = parsed.models || {};
  merged.models = {
    prefix:
      modelsIn.prefix !== undefined ? modelsIn.prefix : DEFAULTS.models.prefix,
    exposePrefix:
      modelsIn.exposePrefix !== undefined
        ? modelsIn.exposePrefix
        : DEFAULTS.models.exposePrefix,
    exposeExempt: Array.isArray(modelsIn.exposeExempt)
      ? modelsIn.exposeExempt
      : DEFAULTS.models.exposeExempt,
    mappings: Object.fromEntries(
      Object.entries(modelsIn.mappings || {}).map(([alias, val]) => {
        if (typeof val === "string") return [alias, { upstream: val }];
        return [alias, val];
      }),
    ),
    restricted: modelsIn.restricted || [],
    allowUnknown:
      modelsIn.allowUnknown === undefined
        ? DEFAULTS.models.allowUnknown
        : !!modelsIn.allowUnknown,
    defaultMaxOutputTokens: modelsIn.defaultMaxOutputTokens,
  };

  // Normalize upstream: no trailing slash.
  merged.upstream = merged.upstream.replace(/\/+$/, "");

  // Normalize gateway auth keys into a Map. Accepts:
  //   - string                       (legacy single key, no limit)
  //   - string[]                     (legacy, all keys unlimited)
  //   - { "sk-key": { tokensPerDay } | null, ... }  (keys with optional limits)
  // Plus the legacy `gatewayApiKey` (string) singular form.
  // Empty map => auth disabled.
  const keyMap = new Map<string, KeyConfig>();
  const pushKey = (k: unknown, cfg: KeyConfig | null | undefined) => {
    if (typeof k !== "string" || k.length === 0) return;
    keyMap.set(k, cfg ?? {});
  };
  if (Array.isArray(parsed.gatewayApiKeys)) {
    for (const k of parsed.gatewayApiKeys) pushKey(k, undefined);
  } else if (typeof parsed.gatewayApiKeys === "string") {
    pushKey(parsed.gatewayApiKeys, undefined);
  } else if (
    parsed.gatewayApiKeys &&
    typeof parsed.gatewayApiKeys === "object"
  ) {
    for (const [k, cfg] of Object.entries(parsed.gatewayApiKeys)) {
      pushKey(k, cfg);
    }
  }
  if (typeof parsed.gatewayApiKey === "string") {
    pushKey(parsed.gatewayApiKey, undefined);
  }
  merged.gatewayApiKeys = keyMap;

  merged.usageFile = parsed.usageFile;

  return merged;
}
