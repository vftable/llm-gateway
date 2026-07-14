// Claude Code subscription transform stacks — request, response, and stream.
//
// Wired into the ClaudeCodeAdapter via requestTransforms/responseTransforms/
// streamTransforms overrides (see providers/catalog/claude-code.ts). Each
// hook is gated on `ctx.provider.catalogId === "claude-code"` so the stages
// are no-ops when composed into a non-subscription route.

import type {
  AnthropicMessagesRequest,
  AnthropicContentBlockStartEvent,
} from "../../wire";
import {
  type RequestTransform,
  type ResponseTransform,
  type StreamTransform,
  type TransformCtx,
  onRequest,
  onResponse,
  onStreamEvent,
} from "../../pipeline";

import {
  buildBillingBlock,
  buildDefaultUpstreamHeaders,
  buildFinalBody,
  buildSystemArray,
  CC_ENTRYPOINT,
  CC_VERSION,
  CCH_PLACEHOLDER,
  CLAUDE_CODE_BETA_BLACKLIST,
  computeCchForBody,
  computeVersionSuffix,
  extractFirstUserText,
  serializeBody,
} from "./billing";
import { scrubAnchorsInPlace } from "./classifier-scrub";
import { normalizeToolNames, ensureCcDecoyTools } from "./tool-normalization";

const GROUP = "claude-code-hooks";
const TOOL_RENAME_KEY = "toolRenameMap";

export const subscriptionActive = (ctx: TransformCtx): boolean =>
  ctx.provider?.catalogId === "claude-code";

function getRenameMap(ctx: TransformCtx): Map<string, string> | null {
  const m = ctx.state?.[TOOL_RENAME_KEY] as Map<string, string> | undefined;
  return m && m.size > 0 ? m : null;
}

function replaceBody(
  body: AnthropicMessagesRequest,
  replacement: AnthropicMessagesRequest,
): void {
  for (const key of Object.keys(body)) delete body[key as keyof typeof body];
  Object.assign(body, replacement);
}

const DEFAULT_USER_ID = {
  device_id: "0dafd4a2414567a892d2ce1c9179965352ca53038d7e71c8201752e19257fa8d",
  account_uuid: "",
  session_id: "0bef5d67-6954-4877-a2c6-45fa14ce4b92",
};

function ensureMetadataUserId(body: AnthropicMessagesRequest): {
  device_id: string;
  account_uuid: string;
  session_id: string;
} {
  const meta = (body.metadata ?? {}) as Record<string, unknown>;
  body.metadata = meta;

  if (typeof meta.user_id === "string" && meta.user_id) {
    try {
      return JSON.parse(meta.user_id);
    } catch {
      // Invalid JSON — fall through to default.
    }
  }

  meta.user_id = JSON.stringify(DEFAULT_USER_ID);
  return DEFAULT_USER_ID;
}

// ---------------------------------------------------------------------------
// Request stack
// ---------------------------------------------------------------------------

export const subscriptionRequestStack: RequestTransform[] = [
  onRequest(
    "messages",
    "claude-code:cc-headers",
    (body, ctx) => {
      if (!subscriptionActive(ctx)) return body;

      const ccHeaders = buildDefaultUpstreamHeaders();
      const merged = new Set([
        ...(ccHeaders["anthropic-beta"] ?? "").split(",").map((s) => s.trim()),
        ...(ctx.headers?.["anthropic-beta"] ?? "")
          .split(",")
          .map((s) => s.trim()),
      ]);

      ctx.headers = {
        ...ctx.headers,
        ...ccHeaders,
        "anthropic-beta": [...merged]
          .filter(
            (v) => !CLAUDE_CODE_BETA_BLACKLIST.includes(v) && v.length > 1,
          )
          .join(","),
      };

      return body;
    },
    {
      label: "Claude Code headers",
      blurb: "Ensure that the request carries Claude Code's required headers.",
      group: GROUP,
    },
  ),

  onRequest(
    "messages",
    "claude-code:classifier-scrub",
    (body, ctx) => {
      if (!subscriptionActive(ctx)) return body;
      replaceBody(body, scrubAnchorsInPlace(body));
      return body;
    },
    {
      label: "Client-fingerprint scrub",
      blurb: "Erase third-party client fingerprints from system[]/messages[].",
      group: GROUP,
    },
  ),

  onRequest(
    "messages",
    "claude-code:tool-normalize",
    (body, ctx) => {
      if (!subscriptionActive(ctx)) return body;

      try {
        const { body: normalized, renameMap } = normalizeToolNames(body);
        replaceBody(body, normalized);
        if (renameMap.size > 0 && ctx.state) {
          ctx.state[TOOL_RENAME_KEY] = renameMap;
        }
      } catch {
        // Normalization failed — keep body as-is.
      }

      replaceBody(body, ensureCcDecoyTools(body));
      return body;
    },
    {
      label: "Tool-name normalization",
      blurb:
        "Rename third-party tool names to Claude Code's PascalCase and inject decoy tools.",
      group: GROUP,
    },
  ),

  onRequest(
    "messages",
    "claude-code:oauth-billing",
    (body, ctx) => {
      if (!subscriptionActive(ctx)) return body;

      const userId = ensureMetadataUserId(body);
      if (ctx.headers)
        ctx.headers["x-claude-code-session-id"] = userId.session_id;

      const version = CC_VERSION;
      const firstUserText = extractFirstUserText(body);
      const suffix = computeVersionSuffix(firstUserText, version);

      // Build with placeholder cch to get the serialized body for hashing.
      const placeholderValue = `cc_version=${version}.${suffix}; cc_entrypoint=${CC_ENTRYPOINT}; cch=${CCH_PLACEHOLDER};`;
      const placeholderSystem = buildSystemArray(
        body.system,
        buildBillingBlock(placeholderValue),
      );

      const placeholderBody = buildFinalBody(body, placeholderSystem);
      const serialized = serializeBody(placeholderBody);

      const cch = computeCchForBody(serialized, version);

      // Rebuild with the real cch.
      const finalValue = `cc_version=${version}.${suffix}; cc_entrypoint=${CC_ENTRYPOINT}; cch=${cch};`;
      const finalSystem = placeholderSystem.map((block, i) =>
        i === 0 ? buildBillingBlock(finalValue) : block,
      );

      replaceBody(body, buildFinalBody(body, finalSystem));
      if (ctx.headers) ctx.headers["x-anthropic-billing-header"] = finalValue;

      return body;
    },
    {
      label: "OAuth billing/attestation",
      blurb:
        "Rebuild system[] into Claude Code's ordering and inject valid billing/attestation headers.",
      group: GROUP,
    },
  ),
];

export const subscriptionResponseStack: ResponseTransform[] = [
  onResponse(
    "messages",
    "claude-code:tool-unrename",
    (body, ctx) => {
      if (!subscriptionActive(ctx)) return body;
      const renameMap = getRenameMap(ctx);
      if (!renameMap || !Array.isArray(body.content)) return body;

      for (const block of body.content) {
        if (block.type === "tool_use" && typeof block.name === "string") {
          const original = renameMap.get(block.name);
          if (original) block.name = original;
        }
      }
      return body;
    },
    {
      label: "Tool-name un-rename",
      blurb:
        "Reverse PascalCase tool names in the response back to the client's original names.",
      group: GROUP,
    },
  ),
];

export const subscriptionStreamStack: StreamTransform[] = [
  onStreamEvent(
    "messages",
    "claude-code:stream-tool-unrename",
    (event, ctx) => {
      console.log(event);

      if (!subscriptionActive(ctx)) return event;
      if (event.type !== "content_block_start") return event;

      const renameMap = getRenameMap(ctx);
      if (!renameMap) return event;

      const { content_block: block } = event as AnthropicContentBlockStartEvent;
      if (block?.type === "tool_use" && typeof block.name === "string") {
        const original = renameMap.get(block.name);
        if (original) block.name = original;
      }

      return event;
    },
    {
      label: "Stream tool-name un-rename",
      blurb:
        "Reverse PascalCase tool names in streaming content_block_start events.",
      group: GROUP,
    },
  ),
];
