// Providers — barrel export (registry + adapter base + quirks + catalog types).
export {
  PROVIDER_TEMPLATES,
  listProviderTemplates,
  getProviderTemplate,
  isProviderTemplate,
  getAdapter,
  adapterForProvider,
} from "./registry";
export {
  ProviderAdapter,
  OpenAICompatibleAdapter,
  AnthropicCompatibleAdapter,
  resolveSuffix,
  type WireFmt,
  type EndpointPlan,
  type BodyXform,
} from "./base";
export {
  applyTemplateDefaults,
  capabilitiesForTemplate,
} from "./quirks";
export type {
  ProviderTemplate,
  ProviderDefaults,
  ProviderQuirks,
  TemplateField,
} from "./types";
