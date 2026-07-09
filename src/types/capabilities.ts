// Model capabilities — the Anthropic-style listing shape the gateway exposes
// per model. Cross-cutting: used by models, the provider catalog, and imports.

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

export interface ContextManagementCapability {
  supported: boolean;
  clear_tool_uses_20250919: CapabilitySupport;
  clear_thinking_20251015: CapabilitySupport;
  compact_20260112: CapabilitySupport;
}

export interface ModelCapabilities {
  batch: CapabilitySupport;
  citations: CapabilitySupport;
  code_execution: CapabilitySupport;
  context_management?: ContextManagementCapability;
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
