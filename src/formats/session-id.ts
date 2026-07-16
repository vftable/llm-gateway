// Shared session/identity helpers for cross-provider cache routing.
//
// Extracts a stable session identifier from whichever field the client
// provides (Anthropic metadata.user_id, OpenAI user field, or a static
// fallback). Used by:
//   - openai-cache transform: sets `prompt_cache_key` so OpenAI routes
//     requests with the same session to the same cache server
//   - claude-code subscription hooks: reads session_id for the
//     x-claude-code-session-id header

import { createHash } from "node:crypto";

export const DEFAULT_SESSION_ID = "0bef5d67-6954-4877-a2c6-45fa14ce4b92";

export const DEFAULT_DEVICE_ID =
  "0dafd4a2414567a892d2ce1c9179965352ca53038d7e71c8201752e19257fa8d";

export interface UserIdentity {
  device_id: string;
  account_uuid: string;
  session_id: string;
}

export const DEFAULT_USER_IDENTITY: UserIdentity = {
  device_id: DEFAULT_DEVICE_ID,
  account_uuid: "",
  session_id: DEFAULT_SESSION_ID,
};

// Parse an Anthropic-shaped metadata.user_id JSON string into its parts.
export function parseAnthropicUserId(raw: unknown): UserIdentity | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.session_id === "string"
    )
      return parsed as UserIdentity;
  } catch {
    // not JSON
  }
  return null;
}

// Extract a stable cache-routing key from a request body. Checks (in order):
//   1. prompt_cache_key (already set by the client — pass through)
//   2. user (OpenAI convention — hash it for stability)
//   3. metadata.user_id (Anthropic convention — extract session_id)
//   4. static fallback so all gateway requests share one cache slot
//
// The returned key is short (≤ 32 chars) and stable across identical inputs.
export function extractCacheKey(body: Record<string, unknown>): string {
  if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key)
    return body.prompt_cache_key;

  if (typeof body.user === "string" && body.user) return shortHash(body.user);

  const meta = body.metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta === "object") {
    const identity = parseAnthropicUserId(meta.user_id);
    if (identity) return shortHash(identity.session_id);
  }

  return "gw-" + DEFAULT_SESSION_ID.slice(0, 8);
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
