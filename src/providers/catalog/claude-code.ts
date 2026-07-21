// Claude Code subscription provider.
//
// Same upstream as the official Anthropic provider (/v1/messages), but its
// adapter wires in the Claude Code request-processing stack from
// formats/anthropic/subscription/index.ts: classifier scrubbing, tool-name
// normalization (PascalCase + decoy stubs), and OAuth billing/attestation
// (cch header computation). Response and stream transforms reverse tool
// renames so the client sees its original tool names.

import {
  AnthropicCompatibleAdapter,
  BuildCtx,
  BuiltRequest,
  type UsageCtx,
  type KeyUsageResult,
} from "../base";
import type {
  RequestTransform,
  ResponseTransform,
  StreamTransform,
} from "../../formats/pipeline";
import {
  subscriptionRequestStack,
  subscriptionResponseStack,
  subscriptionStreamStack,
} from "../../formats/anthropic/subscription/index";
import { WireKind, type Provider } from "../../types";
import { ANTHROPIC_DEFAULT_TRANSFORMS } from "./anthropic-compatible";
import { withBetaQuery } from "../../formats/anthropic/subscription/billing";
import {
  parseUnifiedRateLimitHeaders,
  unifiedRateLimitToUsageWindows,
  unifiedStatusMessage,
} from "../../services/anthropic-unified-usage";

class ClaudeCodeAdapter extends AnthropicCompatibleAdapter {
  requestTransforms(p: Provider): RequestTransform[] {
    return [...super.requestTransforms(p), ...subscriptionRequestStack];
  }

  responseTransforms(p: Provider): ResponseTransform[] {
    return [...super.responseTransforms(p), ...subscriptionResponseStack];
  }

  streamTransforms(p: Provider): StreamTransform[] {
    return [...super.streamTransforms(p), ...subscriptionStreamStack];
  }

  messages(ctx: BuildCtx): BuiltRequest {
    const built = super.messages(ctx);
    built.url = withBetaQuery(built.url);
    return built;
  }

  supportsKeyUsage(_ctx: UsageCtx): boolean {
    return true;
  }

  async keyUsage(ctx: UsageCtx): Promise<KeyUsageResult> {
    if (!ctx.unifiedUsage) {
      return {
        windows: [],
        unavailable: true,
        message: "No usage captured yet — send a request with this key.",
      };
    }
    const info = parseUnifiedRateLimitHeaders(ctx.unifiedUsage.headers);
    if (!info) {
      return {
        windows: [],
        unavailable: true,
        message: "The latest response did not contain unified usage headers.",
      };
    }
    return {
      windows: unifiedRateLimitToUsageWindows(info),
      message: unifiedStatusMessage(info),
      dummy: false,
    };
  }
}

export const claudeCode = new ClaudeCodeAdapter({
  id: "claude-code",
  label: "Claude Code",
  blurb: "Anthropic Messages endpoint with Claude Code OAuth spoofing.",
  brand: "claude",
  docsUrl: "https://docs.anthropic.com/en/api",
  defaults: {
    baseUrl: "https://api.anthropic.com",
    endpoints: [WireKind.Messages],
    authScheme: "bearer",
    nativeConversion: false,
    extraHeaders: { "anthropic-version": "2023-06-01" },
  },
  fields: [
    {
      key: "name",
      label: "Name",
      placeholder: "claude-code",
      required: true,
    },
    {
      key: "apiKeys",
      label: "API key",
      placeholder: "sk-ant-…",
      required: true,
      hint: "One per line — rotated round-robin.",
    },
  ],
  quirks: {
    requiredHeaders: { "anthropic-version": "2023-06-01" },
    thinking: { defaultType: "adaptive", supportsEffort: true },
    // Same Anthropic-family base as anthropic.ts — see
    // ANTHROPIC_DEFAULT_TRANSFORMS's doc comment in anthropic-compatible.ts.
    // The subscription no-op stack (subscriptionRequestStack, above) is a
    // separate untagged requestTransforms() addition, not a quirks default —
    // it has no ModelTransformConfig shape (no library transform backs it),
    // so it can't be seeded/shown the same way; it still appears in the
    // resolved-transforms view as an adapter-level stage (see
    // docs/transforms-api.md).
    defaultTransforms: ANTHROPIC_DEFAULT_TRANSFORMS,
  },
});
