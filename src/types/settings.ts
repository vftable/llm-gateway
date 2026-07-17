// Global settings — a key/value store with a typed view.

export interface Settings {
  modelPrefix: string;
  exposePrefix: string;
  exposeExempt: string[];
  allowUnknown: boolean;
  defaultMaxOutputTokens: number;
  ssePingInterval: number;
  requestLogRetentionDays: number;
  /** Capture distilled request/response payloads into request logs for
   *  debugging (messages, tools, tool calls, response text). */
  debugLogging: boolean;
  /** Back Anthropic's hosted web_search / web_fetch tools with a web provider so
   *  they work against any upstream model (the gateway runs the tool loop). */
  webToolsEnabled: boolean;
  /** Which web provider backs the tools (registry id, e.g. "firecrawl"). */
  webToolsProvider: string;
  /** Provider base URL override (blank = the provider's default endpoint). */
  webProviderBaseUrl: string;
  /** Optional provider API key (blank = keyless where supported). */
  webProviderApiKey: string;
  adminPasswordHash: string | null;
  jwtSecret: string;
}

export const DEFAULT_SETTINGS: Settings = {
  modelPrefix: "",
  exposePrefix: "anthropic/",
  exposeExempt: ["claude"],
  allowUnknown: false,
  defaultMaxOutputTokens: 16384,
  ssePingInterval: 15000,
  requestLogRetentionDays: 30,
  debugLogging: false,
  webToolsEnabled: false,
  webToolsProvider: "firecrawl",
  webProviderBaseUrl: "",
  webProviderApiKey: "",
  adminPasswordHash: null,
  jwtSecret: "",
};
