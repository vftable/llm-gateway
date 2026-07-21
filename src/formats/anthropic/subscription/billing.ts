import { createHash } from "node:crypto";
import { MASK_20, xxHash64 } from "./xxhash64";
import type {
  AnthropicMessagesRequest,
  AnthropicTextBlock,
} from "../../pipeline";
import { ORDERED_KEYS } from "../hooks/sanitize-request";

export const CLAUDE_CODE_BETA_FLAGS = [
  "claude-code-20250219",
  // oauth-2025-04-20 enables OAuth bearer-token auth on /v1/messages and is
  // required for the subscription billing path; fine-grained-tool-streaming is
  // part of Claude Code's current OAuth beta header set.
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "fine-grained-tool-streaming-2025-05-14",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "mid-conversation-system-2026-04-07",
  "advisor-tool-2026-03-01",
  "effort-2025-11-24",
];

export const CLAUDE_CODE_BETA_BLACKLIST = ["redact-thinking-2026-02-12"];

/** Salt for the 3-char hex cc_version suffix (extracted from Claude Code). */
export const BILLING_SALT = "59cf53e54c78";

/**
 * Latest published Claude Code version as of 2026-06-29. This is the single
 * source of truth — config.ts reads it to build the matching `user-agent`.
 * Bump when Anthropic ships a new release; otherwise requests route to
 * "extra usage".
 */
export const CC_VERSION = "2.1.207";

/**
 * Anthropic requires the first content block of any OAuth-authenticated
 * Messages request's `system[]` to be exactly this string (effective March 16,
 * 2026; Sonnet/Opus only — Haiku exempt).
 */
export const CLAUDE_CODE_IDENTITY_TEXT =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/** cc_entrypoint value emitted by Claude Code for interactive CLI use. */
export const CC_ENTRYPOINT = "cli";

/** Static fallback when the body attestation cannot run. */
export const CCH_PLACEHOLDER = "00000";

/** Mask the xxHash64 result to its lower 20 bits (= 5 hex chars). */
export const CCH_MASK = MASK_20;

const BILLING_PREFIX = "x-anthropic-billing-header:";

interface SeedPair {
  readonly seedHigh: number;
  readonly seedLow: number;
}

/** Legacy seed used by Claude Code 2.1.37 (kept for completeness). */
const SEED_2_1_37: SeedPair = { seedHigh: 0x6e52736a, seedLow: 0xc806831e };
/** Verified current seed (v2.1.138+ through v2.1.207 as of 2026-07-14). */
const SEED_CURRENT: SeedPair = { seedHigh: 0x4d659218, seedLow: 0xe32a3268 };

/**
 * Map a Claude Code version to its xxHash64 seed. Only the legacy 2.1.37 used
 * a different seed; every version since 2.1.138 shares SEED_CURRENT. Unknown /
 * future versions fall back to the current seed so the header stays well-formed
 * even before the registry is updated.
 */
function resolveSeed(version: string): SeedPair {
  if (version === "2.1.37") return SEED_2_1_37;
  return SEED_CURRENT;
}

export function isBillingText(text: unknown): boolean {
  return (
    typeof text === "string" && text.trimStart().startsWith(BILLING_PREFIX)
  );
}

// -----------------------------------------------------------------------------
// Version suffix + first-user-text extraction
// -----------------------------------------------------------------------------

/** Compute the 3-char SHA-256 suffix for the cc_version component. */
export function computeVersionSuffix(
  firstUserText: string,
  version: string,
): string {
  // Plain [] indexing (UTF-16 code units) with '0' padding for out-of-bounds,
  // matching Claude Code's implementation exactly.
  const sampled =
    (firstUserText[4] || "0") +
    (firstUserText[7] || "0") +
    (firstUserText[20] || "0");
  return createHash("sha256")
    .update(`${BILLING_SALT}${sampled}${version}`)
    .digest("hex")
    .slice(0, 3);
}

function detectNodeVersion(): string {
  return `v${process.versions.node}`;
}

function detectPlatform(): { arch: string; os: string } {
  const arch =
    process.arch === "x64"
      ? "x64"
      : process.arch === "arm64"
        ? "arm64"
        : process.arch;

  const platform =
    process.platform === "win32"
      ? "Windows"
      : process.platform === "darwin"
        ? "MacOS"
        : process.platform === "linux"
          ? "Linux"
          : process.platform;

  return { arch, os: platform };
}

export function buildDefaultUpstreamHeaders(): Record<string, string> {
  const nodeVersion = detectNodeVersion();
  const { arch, os } = detectPlatform();

  return {
    "user-agent": `claude-cli/${CC_VERSION} (external, cli)`,
    "x-app": "cli",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": nodeVersion,
    "x-stainless-package-version": "0.94.0",
    "x-stainless-timeout": "600",
    "x-stainless-lang": "js",
    "x-stainless-arch": arch,
    "x-stainless-os": os,
    "x-stainless-retry-count": "0",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": CLAUDE_CODE_BETA_FLAGS.join(","),
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

/**
 * Pull the first user-message text from the outgoing request body. Supports
 * string-form content and array-form content with a `{ type: "text", text }`
 * (Anthropic) or `{ type: "input_text", text }` (OpenAI-style) block. Returns
 * the FIRST text block only (not concatenated); '' when no user text is found.
 */
export function extractFirstUserText(
  requestBody: Readonly<AnthropicMessagesRequest>,
): string {
  const messages = requestBody.messages;
  if (!Array.isArray(messages)) return "";
  for (const msg of messages) {
    if (!msg || msg.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const p = part as { type?: string; text?: string };
        if (
          typeof p.text === "string" &&
          (p.type === "text" || p.type === "input_text")
        ) {
          return p.text;
        }
      }
    }
  }
  return "";
}

// -----------------------------------------------------------------------------
// system[] array construction
// -----------------------------------------------------------------------------

export type SystemBlock = AnthropicTextBlock;

function isBillingHeaderBlock(block: SystemBlock): boolean {
  return (
    typeof block.text === "string" && block.text.startsWith(BILLING_PREFIX)
  );
}

function isIdentityBlock(block: SystemBlock): boolean {
  return block.text === CLAUDE_CODE_IDENTITY_TEXT;
}

/** Convert whatever form of `system` upstream provided into a SystemBlock[]. */
export function normalizeSystemBlocks(rawSystem: unknown): SystemBlock[] {
  if (typeof rawSystem === "string") {
    return [{ type: "text", text: rawSystem }];
  }
  if (Array.isArray(rawSystem)) {
    const blocks: SystemBlock[] = [];
    for (const entry of rawSystem) {
      if (typeof entry === "string") {
        blocks.push({ type: "text", text: entry });
        continue;
      }
      if (entry && typeof entry === "object") {
        const e = entry as AnthropicTextBlock;
        if (typeof e.text === "string") {
          const block: SystemBlock = { type: "text", text: e.text };
          if (e.cache_control && typeof e.cache_control === "object") {
            block.cache_control = e.cache_control;
          }
          blocks.push(block);
        }
      }
    }
    return blocks;
  }
  return [];
}

/** Drop any existing identity or billing-header block (idempotent). */
export function stripExistingFingerprint(blocks: SystemBlock[]): SystemBlock[] {
  return blocks.filter((b) => !isIdentityBlock(b) && !isBillingHeaderBlock(b));
}

/**
 * Build the final `system[]` array in the order real Claude Code emits:
 *   system[0]  = billing header block (NO cache_control — rotates per request)
 *   system[1]  = identity block (NO cache_control — matches plugin wire format),
 *               ONLY for Claude models newer than 4.5 (see below)
 *   system[..] = original blocks (cache_control preserved if present)
 */
export function buildSystemArray(
  rawSystem: unknown,
  billingBlock: SystemBlock,
): SystemBlock[] {
  const cleaned = stripExistingFingerprint(normalizeSystemBlocks(rawSystem));

  const identity: SystemBlock = {
    type: "text",
    text: CLAUDE_CODE_IDENTITY_TEXT,
  };
  return [billingBlock, identity, ...cleaned];
}

/** Build the `x-anthropic-billing-header:` text block. */
export function buildBillingBlock(billingHeaderText: string): SystemBlock {
  return {
    type: "text",
    text: `${BILLING_PREFIX} ${billingHeaderText}`,
  };
}

// -----------------------------------------------------------------------------
// Body serialization (deterministic key order)
// -----------------------------------------------------------------------------

/**
 * Top-level keys preserved and serialized in Claude Code's order: `system`,
 * `messages`, `model`, `max_tokens`, ... Unknown keys are dropped so they
 * cannot contaminate the cch preimage.
 */

export function buildFinalBody(
  original: Readonly<AnthropicMessagesRequest>,
  systemArray: SystemBlock[],
): AnthropicMessagesRequest {
  const out: Record<string, unknown> = {};
  out["system"] = systemArray;
  for (const key of ORDERED_KEYS) {
    if (key === "system") continue;
    if (key in original) out[key] = original[key as keyof typeof original];
  }
  return out as AnthropicMessagesRequest;
}

export function serializeBody(body: AnthropicMessagesRequest): string {
  return JSON.stringify(body);
}

// -----------------------------------------------------------------------------
// cch preimage transform (v2.1.172+) + xxHash64 attestation
// -----------------------------------------------------------------------------

// Anthropic's classifier hashes a TRANSFORMED version of the body, not the wire
// body, when computing cch:
//   1. the `model` VALUE is blanked: `"model":"sonnet-4"` → `"model":""`
//   2. the `max_tokens` field is removed (with the adjacent comma stripped)
const MODEL_VALUE_RE = /("model":")[^"]*(")/;
const MAX_TOKENS_FIELD_RE = /"max_tokens":\d+,|,"max_tokens":\d+/;

/**
 * Compute the 5-char lowercase hex `cch` token for a serialized request body.
 * Applies the v2.1.172+ preimage transform, then hashes with the
 * version-resolved seed.
 */
export function computeCchForBody(
  serializedBody: string,
  version: string,
): string {
  try {
    const { seedHigh, seedLow } = resolveSeed(version);
    const preimage = serializedBody
      .replace(MODEL_VALUE_RE, "$1$2")
      .replace(MAX_TOKENS_FIELD_RE, "");
    const bytes = Buffer.from(preimage, "utf8");
    const full = xxHash64(bytes, seedHigh, seedLow);
    return (full & MASK_20).toString(16).padStart(5, "0");
  } catch {
    return CCH_PLACEHOLDER;
  }
}

// -----------------------------------------------------------------------------
// ?beta=true query string
// -----------------------------------------------------------------------------

/**
 * Augment an outgoing Messages URL with `?beta=true`. Idempotent. Preserves
 * any existing query params (appends with `&`). No-op when the path is not
 * `/v1/messages` or `beta=true` is already present.
 */
export function withBetaQuery(url: string): string {
  const messagesIdx = url.indexOf("/messages");
  if (messagesIdx === -1) return url;
  const endpoint = messagesIdx + "/messages".length;
  const head = url.slice(0, endpoint);
  const tail = url.slice(endpoint);
  if (/[?&]beta=true(?:&|$)/.test(tail)) return url;
  const separator = tail.length === 0 ? "?" : "&";
  return `${head}${tail}${separator}beta=true`;
}
