// Extra built-in transform bodies (opt-in, UI-configured per imported model).
//
// These are the "provider-feature / correctness" transforms that go beyond the
// generic field ops in registry.ts. Kept here so registry.ts stays a thin
// catalog. Each factory returns a pure BodyXform; model transforms run AFTER the
// format stage, so the body is already in the CLIENT/PROVIDER wire shape the
// transform targets (Anthropic Messages for an anthropic provider on the request
// side; the client shape on the response side).
//
// Field shapes verified against the live Anthropic Messages docs:
//   cache_control = { type: "ephemeral", ttl?: "5m" | "1h" }, max 4 breakpoints,
//   placed on the last system block / last tool / last message content block.

import type { Json, BodyXform } from "../pipeline";
import { extractCacheKey } from "../session-id";

type Block = Record<string, unknown>;

// --- anthropic-cache: prompt-caching breakpoints ---------------------------

// A library BodyXform has no access to TransformCtx (see apply.ts —
// buildModelTransforms only threads `body` through), so this can't gate on
// ctx.providerFmt the way a format-tagged pipeline stage would. Since
// anthropicCache is now also an unconditional Anthropic-FAMILY default (see
// ANTHROPIC_DEFAULT_TRANSFORMS in providers/catalog/anthropic-compatible.ts —
// applied to every request on that family regardless of the resolved hop
// format), it needs its OWN shape check for the case an operator pins a
// provider endpoint away from Messages (a per-link override the gateway
// allows but that this transform can't see coming). These are strong,
// unambiguous OpenAI Chat/Responses-only markers that never appear on a
// genuine Anthropic Messages body — `role:"tool"` and `tool_calls` don't
// exist in Anthropic's message shape (it uses `tool_use`/`tool_result`
// CONTENT BLOCKS instead), and `{type:"function"}` is OpenAI's tool-wrapper,
// not Anthropic's flat `{name, input_schema}` tool shape.
function looksOpenAIShaped(body: Json): boolean {
  if (Array.isArray(body.tools)) {
    for (const t of body.tools as Block[]) {
      if (t && t.type === "function") return true;
    }
  }
  if (Array.isArray(body.messages)) {
    for (const m of body.messages as Block[]) {
      if (!m) continue;
      if (m.role === "tool" || Array.isArray(m.tool_calls)) return true;
    }
  }
  return false;
}

// Add a cache_control breakpoint to the last system block, the last tool, and
// the last message's last content block — the stable-prefix positions Anthropic
// recommends. Stays within the 4-breakpoint limit (3 here). No-op on a body that
// isn't Anthropic-shaped (including a body that positively looks OpenAI-shaped —
// see looksOpenAIShaped).
export function anthropicCache(ttlRaw: string): BodyXform {
  const ttl = ttlRaw === "1h" ? "1h" : "5m";
  const mark = (b: Block): void => {
    b.cache_control =
      ttl === "1h" ? { type: "ephemeral", ttl } : { type: "ephemeral" };
  };
  return (body: Json) => {
    if (looksOpenAIShaped(body)) return body;

    // system: string -> wrap into a text block so it can carry cache_control.
    if (typeof body.system === "string" && body.system) {
      body.system = [{ type: "text", text: body.system }];
    }
    if (Array.isArray(body.system) && body.system.length) {
      const blocks = body.system as Block[];
      mark(blocks[blocks.length - 1]);
    }
    // tools: last tool.
    if (Array.isArray(body.tools) && body.tools.length) {
      const tools = body.tools as Block[];
      mark(tools[tools.length - 1]);
    }
    // messages: last message's last non-thinking content block.
    if (Array.isArray(body.messages) && body.messages.length) {
      const msgs = body.messages as Array<{ content?: unknown }>;
      const last = msgs[msgs.length - 1];
      if (Array.isArray(last?.content) && last.content.length) {
        const blocks = last.content as Block[];
        for (let i = blocks.length - 1; i >= 0; i--) {
          const t = blocks[i].type;
          if (t !== "thinking" && t !== "redacted_thinking") {
            mark(blocks[i]);
            break;
          }
        }
      }
    }
    return body;
  };
}

// --- openai-cache: extended prompt-cache retention --------------------------

// Set `prompt_cache_retention` on OpenAI-shaped requests so cached prefixes
// persist up to 24 hours (GPU-local storage) instead of the volatile in-memory
// default (5-10 min). No-op on Anthropic-shaped bodies.
export function openaiCache(retention: string): BodyXform {
  const value = retention === "in_memory" ? "in_memory" : "24h";
  return (body: Json) => {
    if (body.system !== undefined) return body;
    if (!Array.isArray(body.messages)) return body;
    if (body.prompt_cache_retention === undefined)
      body.prompt_cache_retention = value;
    if (body.prompt_cache_key === undefined)
      body.prompt_cache_key = extractCacheKey(body);
    return body;
  };
}

// --- system-prepend: prepend a user-supplied system string -----------------

// Shape-aware: prepend `text` to the Anthropic top-level `system` (string or
// block array), or to a chat system message (existing or newly unshifted).
// This is a GENERIC system injection — the text is whatever the user configured,
// NOT any first-party-impersonation prompt.
export function systemPrepend(text: string): BodyXform {
  return (body: Json) => {
    if (!text) return body;
    // Anthropic: top-level system already present.
    if (typeof body.system === "string") {
      body.system = body.system ? `${text}\n${body.system}` : text;
      return body;
    }
    if (Array.isArray(body.system)) {
      (body.system as Block[]).unshift({ type: "text", text });
      return body;
    }
    // Chat: prepend to an existing system message, else unshift one.
    if (Array.isArray(body.messages)) {
      const msgs = body.messages as Array<{ role?: string; content?: unknown }>;
      const sys = msgs.find((m) => m && m.role === "system");
      if (sys && typeof sys.content === "string") {
        sys.content = sys.content ? `${text}\n${sys.content}` : text;
      } else {
        msgs.unshift({ role: "system", content: text });
      }
      return body;
    }
    // Neither present — set an Anthropic system field.
    body.system = text;
    return body;
  };
}

// --- sanitize-tool-args: fix malformed tool-call args (response phase) ------

// Some non-Claude models emit tool-call arguments that break clients: numeric
// params as strings, out-of-range Read limits, invalid pdf page specs. This
// coerces them in BOTH client shapes (Anthropic tool_use.input object; OpenAI
// tool_calls[].function.arguments JSON string). Ported/generalized from
// 9router response/openai-to-claude.js sanitizeToolArgs (opt-in here).
export function sanitizeToolArgs(): BodyXform {
  return (body: Json) => {
    // Anthropic Messages response: content[] tool_use blocks.
    if (Array.isArray(body.content)) {
      for (const b of body.content as Block[]) {
        if (b.type === "tool_use" && b.input && typeof b.input === "object") {
          sanitizeArgs(
            String(b.name ?? ""),
            b.input as Record<string, unknown>,
          );
        }
      }
    }
    // OpenAI Chat response: choices[].message.tool_calls[].function.arguments.
    const choices = body.choices as
      Array<{ message?: { tool_calls?: Array<Block> } }> | undefined;
    if (Array.isArray(choices)) {
      for (const ch of choices) {
        const calls = ch.message?.tool_calls;
        if (!Array.isArray(calls)) continue;
        for (const tc of calls) {
          const fn = tc.function as
            { name?: string; arguments?: string } | undefined;
          if (!fn || typeof fn.arguments !== "string") continue;
          try {
            const parsed = JSON.parse(fn.arguments) as Record<string, unknown>;
            sanitizeArgs(String(fn.name ?? ""), parsed);
            fn.arguments = JSON.stringify(parsed);
          } catch {
            /* leave unparseable args untouched */
          }
        }
      }
    }
    return body;
  };
}

// Coerce a single tool's argument object in place. Currently specialises the
// Read tool (the common offender); numeric-string coercion is safe generally.
function sanitizeArgs(toolName: string, args: Record<string, unknown>): void {
  if (toolName.toLowerCase() === "read") {
    if (typeof args.limit === "string" && /^\d+$/.test(args.limit))
      args.limit = Number(args.limit);
    if (typeof args.offset === "string" && /^-?\d+$/.test(args.offset))
      args.offset = Number(args.offset);
    const limit = args.limit;
    if (typeof limit === "number") {
      if (limit > 2000) args.limit = 2000;
      else if (limit < 1) delete args.limit;
    }
    const offset = args.offset;
    if (typeof offset === "number" && offset < 0) args.offset = 0;
    if ("pages" in args && !validPdfPages(args.file_path, args.pages)) {
      delete args.pages;
    }
  }
}

function validPdfPages(filePath: unknown, pages: unknown): boolean {
  return (
    typeof filePath === "string" &&
    filePath.toLowerCase().endsWith(".pdf") &&
    typeof pages === "string" &&
    /^\d+(?:-\d+)?$/.test(pages)
  );
}
