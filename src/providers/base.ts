// Provider adapter classes.
//
// An adapter owns BOTH a provider's catalog metadata (the data the Add-Provider
// wizard renders) AND its per-endpoint routing behavior. The gateway accepts all
// three inbound wire formats (/v1/chat/completions, /v1/responses, /v1/messages)
// for every provider; each adapter's `chatCompletions` / `messages` / `responses`
// method returns an EndpointPlan describing where that inbound request should be
// sent upstream and (optionally) how to transform it. Whether a cross-format
// conversion is possible is decided by the conversion module in the engine — the
// adapter only picks the upstream path + the provider's native wire format, and
// may override the transform for a provider whose path/shape is non-standard.
//
// Compatible providers "link into each other" by sharing a base class:
// OpenAICompatibleAdapter (native chat) and AnthropicCompatibleAdapter (native
// messages) implement the three methods once; stock providers are instances of
// those (or subclasses when a path is truly bespoke).

import type { Transform } from "stream";
import type {
  Provider,
  ProviderTemplate,
  ProviderDefaults,
  ProviderQuirks,
  TemplateField,
} from "../types";
import type {
  AdapterTransforms,
  RequestTransform,
  ResponseTransform,
  StreamTransform,
} from "../formats/pipeline";

// The three wire formats the gateway understands (mirror of the engine's Fmt;
// identical string-union so the two are structurally interchangeable).
export type WireFmt = "chat" | "messages" | "responses";

export type BodyXform = (
  b: Record<string, unknown>,
) => Record<string, unknown>;

// What an adapter returns for one inbound endpoint. `forwardPath` is the suffix
// appended onto `origin + basePath`. When a transform/bridge is omitted, the
// engine's conversion module supplies the standard converter for
// (clientFmt -> providerFmt); an adapter sets them only to override for a
// non-standard upstream. `unsupported` makes the engine skip to the next
// provider (the inbound format can't be served here).
export interface EndpointPlan {
  forwardPath: string;
  providerFmt: WireFmt;
  reqTransform?: BodyXform;
  respTransform?: BodyXform;
  streamBridge?: () => Transform;
  unsupported?: string;
}

function endsWithKnownSuffix(p: string): boolean {
  const x = p.split("?")[0];
  return (
    x.endsWith("/chat/completions") ||
    x.endsWith("/messages") ||
    x.endsWith("/responses")
  );
}

// Resolve the upstream path suffix for a provider + desired native format:
// explicit per-link endpoint (if a real endpoint) -> provider.endpoints[0] (if
// a real endpoint) -> format default. When basePath is set the default is a
// bare suffix (joined onto origin+basePath); otherwise a legacy full "/v1/…"
// path, so providers created before basePath keep routing byte-identically.
export function resolveSuffix(
  provider: Provider,
  fmt: WireFmt,
  linkEndpoint: string | null,
): string {
  if (linkEndpoint && endsWithKnownSuffix(linkEndpoint)) return linkEndpoint;
  const first = provider.endpoints?.[0];
  if (first && endsWithKnownSuffix(first)) return first;
  if (provider.basePath)
    return fmt === "messages"
      ? "/messages"
      : fmt === "responses"
        ? "/responses"
        : "/chat/completions";
  return fmt === "messages"
    ? "/v1/messages"
    : fmt === "responses"
      ? "/v1/responses"
      : "/v1/chat/completions";
}

export abstract class ProviderAdapter {
  constructor(protected readonly meta: ProviderTemplate) {}

  get id(): string {
    return this.meta.id;
  }
  get label(): string {
    return this.meta.label;
  }
  get brand(): string {
    return this.meta.brand;
  }
  get defaults(): ProviderDefaults {
    return this.meta.defaults;
  }
  get fields(): TemplateField[] {
    return this.meta.fields;
  }
  get quirks(): ProviderQuirks | undefined {
    return this.meta.quirks;
  }

  // The plain metadata shape the API + wizard consume (unchanged contract).
  toTemplate(): ProviderTemplate {
    return this.meta;
  }

  // Inbound endpoint methods — one per client wire format. Default impls below
  // cover the common case; subclasses override a single method for a bespoke
  // upstream path/shape.
  abstract chatCompletions(p: Provider, linkEndpoint: string | null): EndpointPlan;
  abstract messages(p: Provider, linkEndpoint: string | null): EndpointPlan;
  abstract responses(p: Provider, linkEndpoint: string | null): EndpointPlan;

  // Dispatch by inbound client format (called by the engine).
  planFor(
    clientFmt: WireFmt,
    p: Provider,
    linkEndpoint: string | null,
  ): EndpointPlan {
    if (clientFmt === "messages") return this.messages(p, linkEndpoint);
    if (clientFmt === "responses") return this.responses(p, linkEndpoint);
    return this.chatCompletions(p, linkEndpoint);
  }

  // --- custom transform hooks ------------------------------------------------
  // Override any of these in a provider file to inject extra pipeline stages.
  // They are appended AFTER the built-in format conversion, run in array order,
  // and apply identically to streaming and non-streaming responses (the engine
  // feeds them through the same formats/pipeline plan). Default: no extra stages.
  //
  // This is THE place to add provider-specific processing — one method in one
  // file, nothing else changes.
  requestTransforms(_p: Provider): RequestTransform[] {
    return [];
  }
  responseTransforms(_p: Provider): ResponseTransform[] {
    return [];
  }
  streamTransforms(_p: Provider): StreamTransform[] {
    return [];
  }

  // Collected custom stages for this provider, consumed by buildTransformPlan.
  transforms(p: Provider): AdapterTransforms {
    return {
      request: this.requestTransforms(p),
      response: this.responseTransforms(p),
      stream: this.streamTransforms(p),
    };
  }
}

// Native chat provider (OpenAI-compatible). All inbound formats route to the
// provider's chat endpoint; the engine bridges messages/responses -> chat.
export class OpenAICompatibleAdapter extends ProviderAdapter {
  protected chatPlan(p: Provider, linkEndpoint: string | null): EndpointPlan {
    return {
      forwardPath: resolveSuffix(p, "chat", linkEndpoint),
      providerFmt: "chat",
    };
  }
  chatCompletions(p: Provider, e: string | null): EndpointPlan {
    return this.chatPlan(p, e);
  }
  messages(p: Provider, e: string | null): EndpointPlan {
    return this.chatPlan(p, e);
  }
  responses(p: Provider, e: string | null): EndpointPlan {
    return this.chatPlan(p, e);
  }
}

// Native messages provider (Anthropic-compatible). All inbound formats route to
// the provider's /messages endpoint; the engine bridges chat -> messages.
// (responses -> messages has no converter yet, so the engine reports it
// unsupported and falls over to the next provider — unchanged behavior.)
export class AnthropicCompatibleAdapter extends ProviderAdapter {
  protected messagesPlan(p: Provider, linkEndpoint: string | null): EndpointPlan {
    return {
      forwardPath: resolveSuffix(p, "messages", linkEndpoint),
      providerFmt: "messages",
    };
  }
  chatCompletions(p: Provider, e: string | null): EndpointPlan {
    return this.messagesPlan(p, e);
  }
  messages(p: Provider, e: string | null): EndpointPlan {
    return this.messagesPlan(p, e);
  }
  responses(p: Provider, e: string | null): EndpointPlan {
    return this.messagesPlan(p, e);
  }
}
