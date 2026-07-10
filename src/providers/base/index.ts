// Provider adapter classes — a builder scheme.
//
// An adapter owns BOTH a provider's catalog metadata (the data the Add-Provider
// wizard renders) AND its per-endpoint routing behavior. The gateway accepts all
// three inbound wire formats (/v1/chat/completions, /v1/responses, /v1/messages)
// for every provider.
//
// Each hop is handled in TWO phases:
//
//   1. ROUTE (routeFor) — the adapter declares which upstream path + wire format
//      this hop uses. This drives the engine's format-conversion pipeline
//      (messages<->chat<->responses, streaming SSE bridges, thinking, custom
//      transforms), which is unchanged.
//
//   2. BUILD (chatCompletions / messages / responses) — AFTER conversion, the
//      adapter builds the actual outbound HTTP request. The build method receives
//      the model id, the whole request body (already converted to the provider's
//      wire format — editable), the selected API key (from the proxy's key-health
//      logic), and the default URL + headers the engine composed. It returns the
//      final { url, headers, body }. The DEFAULT build forwards everything
//      verbatim (OpenAI, Anthropic, …). A fully non-standard provider overrides
//      one method and rewrites URL + headers + body however it likes — signed
//      URLs, custom auth, request envelopes, anything.
//
// Compatible providers "link into each other" by sharing a base class:
// OpenAICompatibleAdapter (native chat) and AnthropicCompatibleAdapter (native
// messages) set the native format once; stock providers are instances of those
// (or subclasses when a request is truly bespoke).
//
// Split across sibling files by concern:
//   types.ts    — BuildCtx/UsageCtx/TestModelCtx/TestProviderCtx/ModelsCtx +
//                 their result shapes
//   url.ts      — auth headers, URL/path composition, wire-kind resolution
//   models.ts   — fetchModelList + OpenAI/Anthropic -> universal normalization
//   adapter.ts  — the ProviderAdapter abstract class + the two compatible subclasses

export * from "./types";
export * from "./url";
export * from "./models";
export * from "./adapter";
