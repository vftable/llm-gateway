// Stock Anthropic /v1/models entries for Claude models.
//
// When the Anthropic-flavored model listing is served and a gateway model's
// alias corresponds to one of these ids, the stock entry below is returned
// (with the gateway's exposed id) instead of the DB-derived shape, so clients
// like Claude Code see the exact metadata the real Anthropic API would return.

import type { ModelCapabilities } from "../../types";

export interface AnthropicStockModel {
  type: "model";
  id: string;
  display_name: string;
  created_at: string;
  max_input_tokens: number;
  max_tokens: number;
  capabilities: ModelCapabilities;
}

const CONTEXT_MANAGEMENT_FULL = {
  supported: true,
  clear_tool_uses_20250919: { supported: true },
  clear_thinking_20251015: { supported: true },
  compact_20260112: { supported: true },
};

const CONTEXT_MANAGEMENT_NO_COMPACT = {
  supported: true,
  clear_tool_uses_20250919: { supported: true },
  clear_thinking_20251015: { supported: true },
  compact_20260112: { supported: false },
};

const EFFORT_ALL = {
  supported: true,
  low: { supported: true },
  medium: { supported: true },
  high: { supported: true },
  xhigh: { supported: true },
  max: { supported: true },
};

const EFFORT_NO_XHIGH = {
  supported: true,
  low: { supported: true },
  medium: { supported: true },
  high: { supported: true },
  xhigh: { supported: false },
  max: { supported: true },
};

const EFFORT_LEGACY = {
  supported: true,
  low: { supported: true },
  medium: { supported: true },
  high: { supported: true },
  xhigh: { supported: false },
  max: { supported: false },
};

const EFFORT_NONE = {
  supported: false,
  low: { supported: false },
  medium: { supported: false },
  high: { supported: false },
  xhigh: { supported: false },
  max: { supported: false },
};

const THINKING_ADAPTIVE_ONLY = {
  supported: true,
  types: {
    enabled: { supported: false },
    adaptive: { supported: true },
  },
};

const THINKING_BOTH = {
  supported: true,
  types: {
    enabled: { supported: true },
    adaptive: { supported: true },
  },
};

const THINKING_ENABLED_ONLY = {
  supported: true,
  types: {
    enabled: { supported: true },
    adaptive: { supported: false },
  },
};

// Capability profile shared by the Claude 5 family and Opus 4.7/4.8.
const CAPS_MYTHOS_CLASS: ModelCapabilities = {
  batch: { supported: true },
  citations: { supported: true },
  code_execution: { supported: true },
  context_management: CONTEXT_MANAGEMENT_FULL,
  effort: EFFORT_ALL,
  image_input: { supported: true },
  pdf_input: { supported: true },
  structured_outputs: { supported: true },
  thinking: THINKING_ADAPTIVE_ONLY,
};

// Capability profile shared by Opus/Sonnet 4.6.
const CAPS_46_CLASS: ModelCapabilities = {
  batch: { supported: true },
  citations: { supported: true },
  code_execution: { supported: true },
  context_management: CONTEXT_MANAGEMENT_FULL,
  effort: EFFORT_NO_XHIGH,
  image_input: { supported: true },
  pdf_input: { supported: true },
  structured_outputs: { supported: true },
  thinking: THINKING_BOTH,
};

export const ANTHROPIC_STOCK_MODELS: AnthropicStockModel[] = [
  {
    type: "model",
    id: "claude-sonnet-5",
    display_name: "Claude Sonnet 5",
    created_at: "2026-06-29T00:00:00Z",
    max_input_tokens: 1000000,
    max_tokens: 128000,
    capabilities: CAPS_MYTHOS_CLASS,
  },
  {
    type: "model",
    id: "claude-fable-5",
    display_name: "Claude Fable 5",
    created_at: "2026-06-07T00:00:00Z",
    max_input_tokens: 1000000,
    max_tokens: 128000,
    capabilities: CAPS_MYTHOS_CLASS,
  },
  {
    type: "model",
    id: "claude-opus-4-8",
    display_name: "Claude Opus 4.8",
    created_at: "2026-05-28T00:00:00Z",
    max_input_tokens: 1000000,
    max_tokens: 128000,
    capabilities: CAPS_MYTHOS_CLASS,
  },
  {
    type: "model",
    id: "claude-opus-4-7",
    display_name: "Claude Opus 4.7",
    created_at: "2026-04-14T00:00:00Z",
    max_input_tokens: 1000000,
    max_tokens: 128000,
    capabilities: CAPS_MYTHOS_CLASS,
  },
  {
    type: "model",
    id: "claude-sonnet-4-6",
    display_name: "Claude Sonnet 4.6",
    created_at: "2026-02-17T00:00:00Z",
    max_input_tokens: 1000000,
    max_tokens: 128000,
    capabilities: CAPS_46_CLASS,
  },
  {
    type: "model",
    id: "claude-opus-4-6",
    display_name: "Claude Opus 4.6",
    created_at: "2026-02-04T00:00:00Z",
    max_input_tokens: 1000000,
    max_tokens: 128000,
    capabilities: CAPS_46_CLASS,
  },
  {
    type: "model",
    id: "claude-opus-4-5-20251101",
    display_name: "Claude Opus 4.5",
    created_at: "2025-11-24T00:00:00Z",
    max_input_tokens: 200000,
    max_tokens: 64000,
    capabilities: {
      batch: { supported: true },
      citations: { supported: true },
      code_execution: { supported: true },
      context_management: CONTEXT_MANAGEMENT_NO_COMPACT,
      effort: EFFORT_LEGACY,
      image_input: { supported: true },
      pdf_input: { supported: true },
      structured_outputs: { supported: true },
      thinking: THINKING_ENABLED_ONLY,
    },
  },
  {
    type: "model",
    id: "claude-haiku-4-5-20251001",
    display_name: "Claude Haiku 4.5",
    created_at: "2025-10-15T00:00:00Z",
    max_input_tokens: 200000,
    max_tokens: 64000,
    capabilities: {
      batch: { supported: true },
      citations: { supported: true },
      code_execution: { supported: false },
      context_management: CONTEXT_MANAGEMENT_NO_COMPACT,
      effort: EFFORT_NONE,
      image_input: { supported: true },
      pdf_input: { supported: true },
      structured_outputs: { supported: true },
      thinking: THINKING_ENABLED_ONLY,
    },
  },
  {
    type: "model",
    id: "claude-sonnet-4-5-20250929",
    display_name: "Claude Sonnet 4.5",
    created_at: "2025-09-29T00:00:00Z",
    max_input_tokens: 1000000,
    max_tokens: 64000,
    capabilities: {
      batch: { supported: true },
      citations: { supported: true },
      code_execution: { supported: true },
      context_management: CONTEXT_MANAGEMENT_NO_COMPACT,
      effort: EFFORT_NONE,
      image_input: { supported: true },
      pdf_input: { supported: true },
      structured_outputs: { supported: true },
      thinking: THINKING_ENABLED_ONLY,
    },
  },
];

const DATE_SUFFIX = /-\d{8}$/;

// Find the stock entry for a gateway alias. Matches the exact id first, then
// tolerates a date-suffix mismatch in either direction so e.g. an alias of
// "claude-haiku-4-5" still picks up "claude-haiku-4-5-20251001" and
// "claude-sonnet-5-20260629" still picks up "claude-sonnet-5".
export function stockAnthropicModel(
  alias: string,
): AnthropicStockModel | undefined {
  const exact = ANTHROPIC_STOCK_MODELS.find((m) => m.id === alias);
  if (exact) return exact;
  const base = alias.replace(DATE_SUFFIX, "");
  return ANTHROPIC_STOCK_MODELS.find(
    (m) => m.id === base || m.id.replace(DATE_SUFFIX, "") === base,
  );
}
