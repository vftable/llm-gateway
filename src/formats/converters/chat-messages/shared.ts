// Shared helpers used by both the buffered (request.ts/response.ts) and
// streaming (stream-*.ts) directions of the Anthropic<->Chat bridge. Split
// out so none of those needs to import from one another.

import crypto from "crypto";
import type {
  AnthropicBlock as WireAnthropicBlock,
  AnthropicUsage,
  ChatContentPart as WireChatContentPart,
  ChatUsage,
} from "../../wire";

export function genId(prefix: string): string {
  return prefix + crypto.randomBytes(12).toString("hex");
}

// Data URI matcher. `[\s\S]` (not `.`) so a base64 payload containing newlines
// still parses. See docs/format-conversion.md S4.
export const DATA_URI_RE = /^data:([^;]+);base64,([\s\S]+)$/;

// Anthropic requires tool ids to match ^[a-zA-Z0-9_-]+$. OpenAI ids can carry
// characters Anthropic rejects with a 400, so on the way to `messages` we strip
// the disallowed ones and, if nothing survives, synthesize a deterministic id
// (stable across identical requests → prompt-cache friendly). See R1.
const TOOL_ID_RE = /^[a-zA-Z0-9_-]+$/;

export function sanitizeToolId(id: unknown, fallbackSeed: string): string {
  if (typeof id === "string") {
    if (TOOL_ID_RE.test(id)) return id;
    const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "");
    if (cleaned.length > 0) return cleaned;
  }
  return `call_${fallbackSeed.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

// Read reasoning text out of an OpenAI-shaped delta/message across the vendor
// field variants (reasoning_content is the de-facto standard; some layers use
// `reasoning`; MiniMax splits into `reasoning_details[]`). Returns "" if none.
// See S1.
export function extractReasoningText(obj: unknown): string {
  if (!obj || typeof obj !== "object") return "";
  const o = obj as Record<string, unknown>;
  if (typeof o.reasoning_content === "string" && o.reasoning_content)
    return o.reasoning_content;
  if (typeof o.reasoning === "string" && o.reasoning) return o.reasoning;
  const details = o.reasoning_details;
  if (Array.isArray(details)) {
    return details
      .map((d) =>
        typeof d === "string"
          ? d
          : d && typeof d === "object"
            ? ((d as { text?: string; content?: string }).text ??
              (d as { content?: string }).content ??
              "")
            : "",
      )
      .join("");
  }
  return "";
}

// Map OpenAI finish_reason -> Anthropic stop_reason.
export const FINISH_TO_STOP: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "end_turn",
};
export const STOP_TO_FINISH: Record<string, string> = {
  end_turn: "stop",
  max_tokens: "length",
  stop_sequence: "stop",
  tool_use: "tool_calls",
};

// --- usage translation (S2) ------------------------------------------------

export const num = (v: unknown): number => (typeof v === "number" ? v : 0);

// Anthropic usage -> OpenAI usage. Anthropic reports cache tokens separately;
// OpenAI folds them into prompt_tokens and surfaces the split under
// prompt_tokens_details.
export function anthropicUsageToChat(u: AnthropicUsage | undefined): ChatUsage {
  const input = num(u?.input_tokens);
  const output = num(u?.output_tokens);
  const cacheRead = num(u?.cache_read_input_tokens);
  const cacheCreate = num(u?.cache_creation_input_tokens);
  const prompt = input + cacheRead + cacheCreate;
  const usage: ChatUsage = {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt + output,
  };
  if (cacheRead > 0) {
    usage.prompt_tokens_details = { cached_tokens: cacheRead };
  }
  return usage;
}

// OpenAI usage -> Anthropic usage. Subtract the folded-in cache tokens back out
// of prompt_tokens to recover input_tokens, and preserve the split fields.
export function chatUsageToAnthropic(
  u:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: {
          cached_tokens?: number;
          cache_creation_tokens?: number;
        };
      }
    | undefined,
): AnthropicUsage {
  const prompt = num(u?.prompt_tokens);
  const output = num(u?.completion_tokens);
  const cacheRead = num(u?.prompt_tokens_details?.cached_tokens);
  const cacheCreate = num(u?.prompt_tokens_details?.cache_creation_tokens);
  const input = Math.max(0, prompt - cacheRead - cacheCreate);
  const usage: AnthropicUsage = {
    input_tokens: input,
    output_tokens: output,
  };
  if (cacheRead > 0) usage.cache_read_input_tokens = cacheRead;
  if (cacheCreate > 0) usage.cache_creation_input_tokens = cacheCreate;
  return usage;
}

// --- content translation ---------------------------------------------------

export type AnthropicBlock = WireAnthropicBlock;
export type ChatContentPart = WireChatContentPart;

// Anthropic content (string | block[]) -> OpenAI content (string | part[]).
export function anthropicContentToChat(content: unknown): unknown {
  if (content == null) return content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  const parts: ChatContentPart[] = [];
  for (const bRaw of content) {
    if (!bRaw || typeof bRaw !== "object") continue;
    const b = bRaw as AnthropicBlock;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image" || b.type === "input_image") {
      const src = b.source as
        { type?: string; data?: string; media_type?: string } | undefined;
      const url =
        src && src.type === "base64" && src.data
          ? `data:${src.media_type || "image/png"};base64,${src.data}`
          : (b.url as string | undefined);
      if (url) parts.push({ type: "image_url", image_url: { url } });
    }
  }
  return parts.length ? parts : "";
}

// OpenAI content (string | part[]) -> Anthropic content (block[]).
export function chatContentToAnthropic(content: unknown): AnthropicBlock[] {
  const out: AnthropicBlock[] = [];
  if (typeof content === "string") {
    if (content) out.push({ type: "text", text: content });
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const pRaw of content) {
    if (!pRaw || typeof pRaw !== "object") continue;
    const p = pRaw as ChatContentPart;
    if (
      (p.type === "text" ||
        p.type === "input_text" ||
        p.type === "output_text") &&
      typeof p.text === "string"
    ) {
      out.push({ type: "text", text: p.text });
    } else if (p.type === "image_url") {
      const url = (p.image_url as { url?: string } | undefined)?.url;
      if (typeof url === "string") {
        const m = url.match(DATA_URI_RE);
        if (m) {
          out.push({
            type: "image",
            source: { type: "base64", media_type: m[1], data: m[2] },
          });
        } else {
          out.push({ type: "image", source: { type: "url", url } });
        }
      }
    } else if (p.type === "image" && p.source) {
      // Already Anthropic-shaped image (hybrid request) — pass through.
      out.push({ type: "image", source: p.source });
    } else if (p.type === "file") {
      // R4: OpenAI file block -> Claude document. PDF only — Claude rejects
      // other document mimes, so a non-PDF file is dropped, not sent.
      const file = p.file as { file_data?: string } | undefined;
      const m = file?.file_data ? file.file_data.match(DATA_URI_RE) : null;
      if (m && m[1] === "application/pdf") {
        out.push({
          type: "document",
          source: { type: "base64", media_type: m[1], data: m[2] },
        });
      }
    } else if (p.type === "tool_result") {
      // R5: hybrid Chat content already carrying an Anthropic tool_result block
      // — keep it, preserving the is_error flag.
      out.push({
        type: "tool_result",
        tool_use_id: typeof p.tool_use_id === "string" ? p.tool_use_id : "",
        content: p.content,
        ...(p.is_error ? { is_error: p.is_error } : {}),
      });
    } else if (p.type === "tool_use") {
      // Hybrid Chat content already carrying an Anthropic tool_use block — keep
      // it so the tool_use/tool_result ordering normalizer can see it.
      out.push({
        type: "tool_use",
        id: sanitizeToolId(p.id, "tu"),
        name: String(p.name ?? ""),
        input: p.input ?? {},
      });
    } else if (p.type === "thinking" || p.type === "redacted_thinking") {
      // Preserve thinking blocks in-place (the normalizer keeps them ordered).
      out.push(p as AnthropicBlock);
    }
  }
  return out;
}

// --- tools translation -----------------------------------------------------

export function anthropicToolsToChat(
  tools: unknown,
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const tRaw of tools) {
    if (!tRaw || typeof tRaw !== "object") continue;
    const t = tRaw as Record<string, unknown>;
    if (
      t.type === "computer_20241022" ||
      t.type === "web_search" ||
      t.type === "web_search_20250305"
    )
      continue; // hosted, not portable
    out.push({
      type: "function",
      function: {
        name: t.name,
        ...(t.description != null ? { description: t.description } : {}),
        ...(t.input_schema != null ? { parameters: t.input_schema } : {}),
      },
    });
  }
  return out.length ? out : undefined;
}

export function chatToolsToAnthropic(
  tools: unknown,
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const tRaw of tools) {
    if (!tRaw || typeof tRaw !== "object") continue;
    const t = tRaw as Record<string, unknown>;
    const fn = (t.function as Record<string, unknown> | undefined) ?? t;
    if (typeof fn.name !== "string") continue;
    out.push({
      name: fn.name,
      ...(fn.description != null ? { description: fn.description } : {}),
      input_schema: fn.parameters ?? { type: "object", properties: {} },
    });
  }
  return out.length ? out : undefined;
}

export function anthropicToolChoiceToChat(tc: unknown): unknown {
  if (tc == null || typeof tc !== "object") return tc;
  const o = tc as Record<string, unknown>;
  switch (o.type) {
    case "any":
      return "required";
    case "auto":
      return "auto";
    case "none":
      return "none";
    case "tool":
      return typeof o.name === "string"
        ? { type: "function", function: { name: o.name } }
        : tc;
    default:
      return tc;
  }
}

export function chatToolChoiceToAnthropic(tc: unknown): unknown {
  if (typeof tc === "string") {
    switch (tc) {
      case "required":
        return { type: "any" };
      case "auto":
      case "none":
        return { type: tc };
      default:
        return { type: "auto" };
    }
  }
  if (tc && typeof tc === "object") {
    const fn = (tc as Record<string, unknown>).function as
      { name?: string } | undefined;
    if (fn && typeof fn.name === "string")
      return { type: "tool", name: fn.name };
  }
  return { type: "auto" };
}

export function safeParse(s: string | undefined): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
