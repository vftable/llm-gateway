// Bidirectional bridge between the Anthropic Messages API (/v1/messages) and
// the OpenAI Chat Completions API (/v1/chat/completions).
//
// Used by the gateway when a model's chosen provider endpoint speaks a
// different wire format than the client. The request side converts the body
// the client sent into the provider's shape; the response side converts the
// provider's reply back into the client's shape. Streaming responses are
// converted chunk-by-chunk via the two transform streams below.
//
// Coverage:
//   - text content (string and part arrays)
//   - system prompt (system message <-> `system` field)
//   - images (anthropic image source <-> openai image_url)
//   - tools (input_schema <-> parameters) and tool_choice shapes
//   - tool_use <-> assistant tool_calls; tool_result <-> role:'tool'
//   - stop_reason / finish_reason mapping
//   - usage token-field renaming
//   - reasoning_effort passthrough
//
// We only model the fields we touch; everything else is passed through
// opaquely via index signatures.

import crypto from "crypto";
import { Transform, type TransformCallback } from "stream";
import { stripInvisible } from "../../utils";

// --- shared helpers --------------------------------------------------------

function genId(prefix: string): string {
  return prefix + crypto.randomBytes(12).toString("hex");
}

// Data URI matcher. `[\s\S]` (not `.`) so a base64 payload containing newlines
// still parses. See docs/format-conversion.md S4.
const DATA_URI_RE = /^data:([^;]+);base64,([\s\S]+)$/;

// Anthropic requires tool ids to match ^[a-zA-Z0-9_-]+$. OpenAI ids can carry
// characters Anthropic rejects with a 400, so on the way to `messages` we strip
// the disallowed ones and, if nothing survives, synthesize a deterministic id
// (stable across identical requests → prompt-cache friendly). See R1.
const TOOL_ID_RE = /^[a-zA-Z0-9_-]+$/;

function sanitizeToolId(id: unknown, fallbackSeed: string): string {
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
function extractReasoningText(obj: unknown): string {
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
const FINISH_TO_STOP: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "end_turn",
};
const STOP_TO_FINISH: Record<string, string> = {
  end_turn: "stop",
  max_tokens: "length",
  stop_sequence: "stop",
  tool_use: "tool_calls",
};

// --- usage translation (S2) ------------------------------------------------

const num = (v: unknown): number => (typeof v === "number" ? v : 0);

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_creation_tokens?: number;
  };
}

// Anthropic usage -> OpenAI usage. Anthropic reports cache tokens separately;
// OpenAI folds them into prompt_tokens and surfaces the split under
// prompt_tokens_details.
function anthropicUsageToChat(u: AnthropicUsage | undefined): ChatUsage {
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
  if (cacheRead > 0 || cacheCreate > 0) {
    usage.prompt_tokens_details = {};
    if (cacheRead > 0) usage.prompt_tokens_details.cached_tokens = cacheRead;
    if (cacheCreate > 0)
      usage.prompt_tokens_details.cache_creation_tokens = cacheCreate;
  }
  return usage;
}

// OpenAI usage -> Anthropic usage. Subtract the folded-in cache tokens back out
// of prompt_tokens to recover input_tokens, and preserve the split fields.
function chatUsageToAnthropic(
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

type AnthropicBlock = Record<string, unknown>;
type ChatContentPart = Record<string, unknown>;

// Anthropic content (string | block[]) -> OpenAI content (string | part[]).
function anthropicContentToChat(content: unknown): unknown {
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
function chatContentToAnthropic(content: unknown): AnthropicBlock[] {
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

function anthropicToolsToChat(
  tools: unknown,
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const tRaw of tools) {
    if (!tRaw || typeof tRaw !== "object") continue;
    const t = tRaw as Record<string, unknown>;
    if (t.type === "computer_20241022" || t.type === "web_search") continue; // hosted, not portable
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

function chatToolsToAnthropic(
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

function anthropicToolChoiceToChat(tc: unknown): unknown {
  if (tc == null || typeof tc !== "object") return tc;
  const o = tc as Record<string, unknown>;
  if (o.type === "any") return "required";
  if (o.type === "auto") return "auto";
  if (o.type === "none") return "none";
  if (o.type === "tool" && typeof o.name === "string")
    return { type: "function", function: { name: o.name } };
  return tc;
}

function chatToolChoiceToAnthropic(tc: unknown): unknown {
  if (typeof tc === "string") {
    if (tc === "required") return { type: "any" };
    if (tc === "auto" || tc === "none") return { type: tc };
    return { type: "auto" };
  }
  if (tc && typeof tc === "object") {
    const o = tc as Record<string, unknown>;
    const fn = o.function as { name?: string } | undefined;
    if (fn && typeof fn.name === "string")
      return { type: "tool", name: fn.name };
  }
  return { type: "auto" };
}

// --- request: Anthropic Messages -> OpenAI Chat ----------------------------

interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export function messagesRequestToChat(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const messages: ChatMessage[] = [];

  // system -> leading system message (string or text blocks).
  if (body.system != null) {
    const sys = Array.isArray(body.system)
      ? (body.system as Array<Record<string, unknown>>)
          .map((b) => (typeof b.text === "string" ? b.text : ""))
          .join("\n")
      : typeof body.system === "string"
        ? body.system
        : "";
    if (sys) messages.push({ role: "system", content: sys });
  }

  const inMessages = Array.isArray(body.messages) ? body.messages : [];
  for (const mRaw of inMessages) {
    if (!mRaw || typeof mRaw !== "object") continue;
    const m = mRaw as { role?: string; content?: unknown };
    const role = m.role === "assistant" ? "assistant" : "user";

    // Split out tool_result blocks — these become their own role:'tool' msgs.
    if (Array.isArray(m.content)) {
      const blocks = m.content as AnthropicBlock[];
      const results = blocks.filter((b) => b.type === "tool_result");
      const rest = blocks.filter((b) => b.type !== "tool_result");
      for (const r of results) {
        const rc = r.content;
        const text =
          typeof rc === "string"
            ? rc
            : Array.isArray(rc)
              ? (rc as Array<Record<string, unknown>>)
                  .map((b) => (typeof b.text === "string" ? b.text : ""))
                  .join("")
              : "";
        messages.push({
          role: "tool",
          tool_call_id: typeof r.tool_use_id === "string" ? r.tool_use_id : "",
          content: text,
        });
      }
      if (rest.length) {
        const msg = assembleChatMessage(role, rest);
        if (msg) messages.push(msg);
      }
    } else {
      const msg = assembleChatMessage(role, m.content);
      if (msg) messages.push(msg);
    }
  }

  // R2: OpenAI requires every assistant tool_call to be followed by a matching
  // role:"tool" message. Anthropic is lenient, so fill any gap before forwarding.
  fixMissingToolResponses(messages);

  out.messages = messages;
  if (typeof body.model === "string") out.model = body.model;
  if (typeof body.max_tokens === "number") out.max_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.top_k != null) out.top_k = body.top_k;
  if (Array.isArray(body.stop_sequences)) out.stop = body.stop_sequences;
  if (body.stream != null) out.stream = body.stream;
  // Anthropic carries the end-user id under metadata.user_id; Chat uses `user`.
  if (typeof body.user === "string") out.user = body.user;
  else {
    const meta = body.metadata as { user_id?: unknown } | undefined;
    if (meta && typeof meta.user_id === "string") out.user = meta.user_id;
  }

  // R8: carry a reasoning-effort hint through unchanged (Anthropic extended-
  // thinking hint -> OpenAI reasoning_effort) so a reasoning-aware upstream sees it.
  const reasoning = body.reasoning as { effort?: unknown } | undefined;
  if (body.reasoning_effort !== undefined)
    out.reasoning_effort = body.reasoning_effort;
  else if (reasoning?.effort !== undefined)
    out.reasoning_effort = reasoning.effort;

  const tools = anthropicToolsToChat(body.tools);
  if (tools) out.tools = tools;
  const tc = anthropicToolChoiceToChat(body.tool_choice);
  if (tc != null) out.tool_choice = tc;

  return out;
}

// R2: insert a placeholder role:"tool" reply for any assistant tool_call whose
// id is not answered by an immediately-following tool message. Mutates in place.
function fixMissingToolResponses(messages: ChatMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
    const callIds = msg.tool_calls.map((tc) => tc.id).filter(Boolean);
    if (callIds.length === 0) continue;

    // Collect ids answered by the contiguous run of tool messages that follows.
    const answered = new Set<string>();
    let insertAt = i + 1;
    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j];
      if (next.role === "tool" && next.tool_call_id) {
        answered.add(next.tool_call_id);
        insertAt = j + 1;
      } else break;
    }

    const missing = callIds.filter((id) => !answered.has(id));
    if (missing.length > 0) {
      const fillers: ChatMessage[] = missing.map((id) => ({
        role: "tool",
        tool_call_id: id,
        content: "[No response received]",
      }));
      messages.splice(insertAt, 0, ...fillers);
      i = insertAt + fillers.length - 1;
    }
  }
}

// Build one Chat message from a role + anthropic content (string or non-result
// block array). Returns null when there's nothing (e.g. only tool_results).
function assembleChatMessage(
  role: string,
  content: unknown,
): ChatMessage | null {
  if (role === "assistant") {
    // Pull tool_use blocks into tool_calls.
    const blocks = Array.isArray(content)
      ? (content as AnthropicBlock[])
      : typeof content === "string"
        ? [{ type: "text", text: content }]
        : [];
    const toolCalls: NonNullable<ChatMessage["tool_calls"]> = [];
    const parts: ChatContentPart[] = [];
    for (const b of blocks) {
      if (b.type === "tool_use") {
        toolCalls.push({
          id: typeof b.id === "string" ? b.id : genId("call_"),
          type: "function",
          function: {
            name: String(b.name ?? ""),
            arguments:
              typeof b.input === "string"
                ? b.input
                : JSON.stringify(b.input ?? {}),
          },
        });
      } else if (b.type === "text" && typeof b.text === "string") {
        parts.push({ type: "text", text: b.text });
      }
    }
    const msg: ChatMessage = { role };
    if (parts.length === 1) msg.content = parts[0].text;
    else if (parts.length > 1) msg.content = parts;
    else msg.content = null;
    if (toolCalls.length) msg.tool_calls = toolCalls;
    // Only push if there's something to say.
    if (msg.content == null && !toolCalls.length) return null;
    return msg;
  }
  // user
  if (typeof content === "string") {
    return content ? { role, content } : null;
  }
  const converted = anthropicContentToChat(content);
  if (Array.isArray(converted) && converted.length === 0) return null;
  if (typeof converted === "string" && !converted) return null;
  return { role, content: converted };
}

// --- request: OpenAI Chat -> Anthropic Messages ----------------------------

export function chatRequestToMessages(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const messages: Array<{ role: string; content: unknown }> = [];
  let systemText = "";

  const inMessages = Array.isArray(body.messages) ? body.messages : [];
  for (const mRaw of inMessages) {
    if (!mRaw || typeof mRaw !== "object") continue;
    const m = mRaw as ChatMessage;
    // `developer` is OpenAI's renamed system role; Anthropic only has top-level
    // `system`, so fold both in (text extracted from string or part array).
    if (m.role === "system" || m.role === "developer") {
      const t =
        typeof m.content === "string"
          ? m.content
          : extractChatText(m.content);
      if (t) systemText = systemText ? `${systemText}\n${t}` : t;
      continue;
    }
    if (m.role === "tool") {
      // -> a user message with a single tool_result block. R1: sanitize the id.
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: sanitizeToolId(m.tool_call_id, `tr${messages.length}`),
            content:
              typeof m.content === "string"
                ? m.content
                : JSON.stringify(m.content ?? ""),
          },
        ],
      });
      continue;
    }
    const role = m.role === "assistant" ? "assistant" : "user";
    const blocks: AnthropicBlock[] = [];
    // Content parts first (text/images, and any Anthropic-shaped tool_use blocks
    // a hybrid client already embedded), then OpenAI tool_calls as tool_use.
    blocks.push(...chatContentToAnthropic(m.content));
    if (role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        blocks.push({
          type: "tool_use",
          id: sanitizeToolId(tc.id, `tu${messages.length}`),
          name: tc.function.name,
          input: safeParse(tc.function.arguments),
        });
      }
    }
    if (blocks.length) messages.push({ role, content: blocks });
  }

  // Anthropic requires strict user/assistant alternation and a specific
  // tool_use/tool_result shape. Normalize the assembled turns:
  //   1. drop text emitted AFTER a tool_use in an assistant turn (Anthropic 400)
  //   2. merge consecutive same-role turns (tool_result blocks first)
  const normalized = normalizeAnthropicMessages(messages);

  // R3: Anthropic has no response_format. Translate a JSON-mode request into an
  // appended system instruction so the model still targets JSON output.
  const jsonInstruction = responseFormatToInstruction(body.response_format);
  if (jsonInstruction)
    systemText = systemText ? `${systemText}\n${jsonInstruction}` : jsonInstruction;

  if (systemText) out.system = systemText;
  out.messages = normalized;
  if (typeof body.model === "string") out.model = body.model;
  if (typeof body.max_tokens === "number") out.max_tokens = body.max_tokens;
  else if (typeof body.max_completion_tokens === "number")
    out.max_tokens = body.max_completion_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  // top_k is Anthropic-only among the two, but a Chat client may still send it;
  // pass it through so nothing is silently lost.
  if (body.top_k != null) out.top_k = body.top_k;
  if (body.stream != null) out.stream = body.stream;
  // stop (Chat) -> stop_sequences (Anthropic). Accept string or string[].
  if (typeof body.stop === "string") out.stop_sequences = [body.stop];
  else if (Array.isArray(body.stop)) out.stop_sequences = body.stop;
  // R7: Anthropic requires max_tokens; default generously if absent.
  if (typeof out.max_tokens !== "number") out.max_tokens = 4096;

  // metadata: Chat carries a flat `user` string; Anthropic wants
  // metadata.user_id. Carry either representation across.
  const meta = body.metadata as { user_id?: unknown } | undefined;
  if (typeof body.user === "string") out.metadata = { user_id: body.user };
  else if (meta && typeof meta === "object" && meta.user_id != null)
    out.metadata = { user_id: meta.user_id };

  // R8: pass an OpenAI reasoning_effort hint through as Anthropic's reasoning.effort.
  if (body.reasoning_effort !== undefined)
    out.reasoning = { effort: body.reasoning_effort };

  const tools = chatToolsToAnthropic(body.tools);
  if (tools) out.tools = tools;
  const tc = chatToolChoiceToAnthropic(body.tool_choice);
  if (tc != null) out.tool_choice = tc;

  return out;
}

// Extract concatenated text from a Chat message content (string or part array).
function extractChatText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const p of content) {
    if (p && typeof p === "object") {
      const o = p as { type?: string; text?: unknown };
      if (
        (o.type === "text" ||
          o.type === "input_text" ||
          o.type === "output_text") &&
        typeof o.text === "string"
      )
        parts.push(o.text);
    }
  }
  return parts.join("\n");
}

// Normalize assembled Anthropic turns so the body satisfies the Messages API:
//   1. In an assistant turn containing tool_use, drop any text block that comes
//      AFTER the first tool_use (Anthropic rejects trailing text there). Thinking
//      blocks are kept wherever they sit.
//   2. Merge consecutive same-role turns into one, placing tool_result blocks
//      before other content (Anthropic requires tool_result at the start of the
//      following user turn).
// Ported from 9router's fixToolUseOrdering (structural rules only).
function normalizeAnthropicMessages(
  messages: Array<{ role: string; content: unknown }>,
): Array<{ role: string; content: unknown }> {
  // Pass 1: strip text-after-tool_use in assistant turns.
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const blocks = msg.content as AnthropicBlock[];
    if (!blocks.some((b) => b.type === "tool_use")) continue;
    const kept: AnthropicBlock[] = [];
    let sawToolUse = false;
    for (const b of blocks) {
      if (b.type === "tool_use") {
        sawToolUse = true;
        kept.push(b);
      } else if (b.type === "thinking" || b.type === "redacted_thinking") {
        kept.push(b);
      } else if (!sawToolUse) {
        kept.push(b);
      }
      // else: text/other after tool_use — dropped.
    }
    msg.content = kept;
  }

  // Pass 2: merge consecutive same-role turns.
  const merged: Array<{ role: string; content: AnthropicBlock[] }> = [];
  for (const msg of messages) {
    const asBlocks = Array.isArray(msg.content)
      ? (msg.content as AnthropicBlock[])
      : [{ type: "text", text: String(msg.content ?? "") } as AnthropicBlock];
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      const all = [...last.content, ...asBlocks];
      const results = all.filter((b) => b.type === "tool_result");
      const others = all.filter((b) => b.type !== "tool_result");
      last.content = [...results, ...others];
    } else {
      merged.push({ role: msg.role, content: [...asBlocks] });
    }
  }
  return merged;
}

// R3: build the system instruction that stands in for OpenAI's response_format.
// Returns "" when the request asked for no particular format.
function responseFormatToInstruction(rf: unknown): string {
  if (!rf || typeof rf !== "object") return "";
  const o = rf as {
    type?: string;
    json_schema?: { schema?: unknown };
  };
  if (o.type === "json_schema" && o.json_schema?.schema) {
    const schemaJson = JSON.stringify(o.json_schema.schema, null, 2);
    return (
      "You must respond with valid JSON that strictly follows this JSON schema:\n" +
      "```json\n" +
      schemaJson +
      "\n```\n" +
      "Respond ONLY with the JSON object, no other text."
    );
  }
  if (o.type === "json_object") {
    return "You must respond with valid JSON. Respond ONLY with a JSON object, no other text.";
  }
  return "";
}

function safeParse(s: string | undefined): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// --- response: OpenAI Chat -> Anthropic Messages (non-streaming) -----------

export function chatResponseToMessages(
  chat: Record<string, unknown>,
): Record<string, unknown> {
  const choices =
    (chat.choices as Array<Record<string, unknown>> | undefined) ?? [];
  const choice = choices[0] ?? {};
  const msg = (choice.message as Record<string, unknown> | undefined) ?? {};
  const content: AnthropicBlock[] = [];

  // S1: OpenAI reasoning_content -> leading Anthropic thinking block.
  const reasoning = extractReasoningText(msg);
  if (reasoning) content.push({ type: "thinking", thinking: reasoning });

  if (typeof msg.content === "string" && msg.content) {
    content.push({ type: "text", text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const p of msg.content as AnthropicBlock[]) {
      if (typeof p.text === "string")
        content.push({ type: "text", text: p.text });
    }
  }
  const stopReason =
    FINISH_TO_STOP[choice.finish_reason as string] ?? "end_turn";

  const toolCalls = msg.tool_calls as
    | Array<{ id: string; function: { name: string; arguments?: string } }>
    | undefined;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      content.push({
        type: "tool_use",
        id: tc.id || genId("toolu_"),
        name: tc.function.name,
        input: safeParse(tc.function.arguments),
      });
    }
  }

  const usage = chatUsageToAnthropic(
    chat.usage as Parameters<typeof chatUsageToAnthropic>[0],
  );

  return {
    id: (chat.id as string) || genId("msg_"),
    type: "message",
    role: "assistant",
    model: chat.model ?? "",
    content: content.length ? content : [{ type: "text", text: "" }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

// --- response: Anthropic Messages -> OpenAI Chat (non-streaming) -----------

export function messagesResponseToChat(
  msgBody: Record<string, unknown>,
): Record<string, unknown> {
  const blocks = (msgBody.content as AnthropicBlock[] | undefined) ?? [];
  let textContent: string | null = null;
  let reasoningContent: string | null = null;
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") {
      textContent = textContent == null ? b.text : textContent + b.text;
    } else if (b.type === "thinking" && typeof b.thinking === "string") {
      // S1: Anthropic thinking block -> OpenAI reasoning_content.
      reasoningContent =
        reasoningContent == null ? b.thinking : reasoningContent + b.thinking;
    } else if (b.type === "tool_use") {
      toolCalls.push({
        id: (b.id as string) || genId("call_"),
        type: "function",
        function: {
          name: String(b.name ?? ""),
          arguments: JSON.stringify(b.input ?? {}),
        },
      });
    }
  }
  const message: Record<string, unknown> = { role: "assistant" };
  if (textContent != null) message.content = textContent;
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (textContent == null && !toolCalls.length) message.content = null;
  if (reasoningContent != null) message.reasoning_content = reasoningContent;

  const finish = STOP_TO_FINISH[msgBody.stop_reason as string] ?? "stop";
  const usage = anthropicUsageToChat(msgBody.usage as AnthropicUsage);

  return {
    id: (msgBody.id as string) || genId("chatcmpl-"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: msgBody.model ?? "",
    choices: [{ index: 0, message, finish_reason: finish }],
    usage,
  };
}

// ===========================================================================
// Streaming transforms
// ===========================================================================

// Chat SSE -> Anthropic Messages SSE.
//
// Chat chunks carry delta.content / delta.tool_calls / finish_reason + usage.
// We emit the Anthropic event sequence:
//   message_start -> content_block_start/delta/stop -> message_delta -> message_stop
export class ChatToMessagesSseTransform extends Transform {
  private buf = Buffer.alloc(0);
  private started = false;
  private finished = false;
  private nextIndex = 0;
  private textBlockOpen = false;
  private thinkingBlockOpen = false;
  private toolBlocks = new Map<number, number>(); // chat tool index -> anthropic block index
  private readonly model: string | null;

  constructor(model?: string | null) {
    super();
    this.model = model ?? null;
  }

  _transform(chunk: Buffer, _enc: string, cb: TransformCallback): void {
    this.buf = Buffer.concat([
      this.buf,
      Buffer.from(stripInvisible(chunk.toString("utf8")), "utf8"),
    ]);
    while (true) {
      const idx = this.buf.indexOf("\n\n");
      if (idx === -1) break;
      const evt = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      this.handleEvent(evt.toString("utf8"));
    }
    cb();
  }

  _flush(cb: TransformCallback): void {
    if (this.buf.length && !this.finished)
      this.handleEvent(this.buf.toString("utf8"));
    this.buf = Buffer.alloc(0);
    cb();
  }

  private send(obj: { type: string } & Record<string, unknown>): void {
    // Anthropic SSE uses an `event: <type>` line plus a `data:` line. Both are
    // required — clients (e.g. Claude Code) key off the event line.
    this.push(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
  }

  private startMessage(): void {
    this.started = true;
    this.send({
      type: "message_start",
      message: {
        id: genId("msg_"),
        type: "message",
        role: "assistant",
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  private openTextBlock(): number {
    const i = this.nextIndex++;
    this.textBlockOpen = true;
    this.send({
      type: "content_block_start",
      index: i,
      content_block: { type: "text", text: "" },
    });
    return i;
  }

  // S1: thinking block lifecycle. Reasoning arrives before content in practice.
  private openThinkingBlock(): number {
    const i = this.nextIndex++;
    this.thinkingBlockOpen = true;
    this.send({
      type: "content_block_start",
      index: i,
      content_block: { type: "thinking", thinking: "" },
    });
    return i;
  }

  private closeThinkingBlock(): void {
    if (!this.thinkingBlockOpen) return;
    this.send({ type: "content_block_stop", index: this.nextIndex - 1 });
    this.thinkingBlockOpen = false;
  }

  private handleEvent(raw: string): void {
    const lines = raw.split("\n");
    let dataStr = "";
    for (const line of lines) {
      if (line.startsWith("data:")) {
        const p = line.slice(5);
        dataStr += p.startsWith(" ") ? p.slice(1) : p;
      }
    }
    if (!dataStr) return;
    if (this.finished) return; // ignore trailing [DONE] / chunks after message_stop
    if (dataStr === "[DONE]") {
      if (!this.started) this.startMessage();
      this.closeThinkingBlock();
      if (this.textBlockOpen) {
        this.send({ type: "content_block_stop", index: this.nextIndex - 1 });
        this.textBlockOpen = false;
      }
      for (const idx of this.toolBlocks.values())
        this.send({ type: "content_block_stop", index: idx });
      this.toolBlocks.clear();
      this.send({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 0 },
      });
      this.send({ type: "message_stop" });
      this.finished = true;
      return;
    }
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(dataStr);
    } catch {
      return;
    }
    if (!this.started) this.startMessage();

    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    const delta = choice?.delta as Record<string, unknown> | undefined;
    if (delta) {
      // S1: reasoning_content -> thinking block (streamed before text).
      const reasoning = extractReasoningText(delta);
      if (reasoning) {
        if (this.textBlockOpen) {
          this.send({ type: "content_block_stop", index: this.nextIndex - 1 });
          this.textBlockOpen = false;
        }
        if (!this.thinkingBlockOpen) this.openThinkingBlock();
        this.send({
          type: "content_block_delta",
          index: this.nextIndex - 1,
          delta: { type: "thinking_delta", thinking: reasoning },
        });
      }
      if (typeof delta.content === "string" && delta.content) {
        this.closeThinkingBlock();
        if (!this.textBlockOpen) this.openTextBlock();
        this.send({
          type: "content_block_delta",
          index: this.nextIndex - 1,
          delta: { type: "text_delta", text: delta.content },
        });
      }
      const tcArr = delta.tool_calls as
        | Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>
        | undefined;
      if (Array.isArray(tcArr)) {
        // Close any open text/thinking block before emitting tool_use.
        this.closeThinkingBlock();
        if (this.textBlockOpen) {
          this.send({ type: "content_block_stop", index: this.nextIndex - 1 });
          this.textBlockOpen = false;
        }
        for (const tc of tcArr) {
          const ci = tc.index ?? 0;
          let blockIndex = this.toolBlocks.get(ci);
          if (blockIndex === undefined) {
            blockIndex = this.nextIndex++;
            this.toolBlocks.set(ci, blockIndex);
            this.send({
              type: "content_block_start",
              index: blockIndex,
              content_block: {
                type: "tool_use",
                id: tc.id || genId("toolu_"),
                name: tc.function?.name ?? "",
                input: {},
              },
            });
          } else if (tc.function?.name) {
            // name arriving late (rare) — ignore
          }
          if (tc.function?.arguments) {
            this.send({
              type: "content_block_delta",
              index: blockIndex,
              delta: {
                type: "input_json_delta",
                partial_json: tc.function.arguments,
              },
            });
          }
        }
      }
    }

    const finish = choice?.finish_reason as string | undefined;
    if (finish) {
      this.closeThinkingBlock();
      if (this.textBlockOpen) {
        this.send({ type: "content_block_stop", index: this.nextIndex - 1 });
        this.textBlockOpen = false;
      }
      for (const idx of this.toolBlocks.values())
        this.send({ type: "content_block_stop", index: idx });
      this.toolBlocks.clear();
      // S2: fold OpenAI usage into Anthropic shape (cache split preserved).
      const anthUsage = chatUsageToAnthropic(
        chunk.usage as Parameters<typeof chatUsageToAnthropic>[0],
      );
      this.send({
        type: "message_delta",
        delta: {
          stop_reason: FINISH_TO_STOP[finish] ?? "end_turn",
          stop_sequence: null,
        },
        usage: anthUsage,
      });
      this.send({ type: "message_stop" });
      this.finished = true;
    }
  }
}

// Anthropic Messages SSE -> Chat SSE chunks.
//
// Walks Anthropic content_block_start/delta/stop + message_delta/stop and
// emits chat.completion.chunk objects with delta.content / tool_calls /
// finish_reason + usage on the final chunk.
export class MessagesToChatSseTransform extends Transform {
  private buf = Buffer.alloc(0);
  private started = false;
  private readonly model: string | null;
  private textBlockOpen = false;
  // Map anthropic block index -> chat tool index + accumulating id/name.
  private toolBlocks = new Map<
    number,
    { chatIndex: number; id: string; name: string }
  >();
  private nextToolChatIndex = 0;
  private finishReason: string | null = null;
  // S2: accumulate Anthropic-shaped usage. Anthropic sends input + cache in
  // message_start and only output_tokens in message_delta, so we merge across
  // events and convert to OpenAI shape once, at message_stop.
  private anthUsage: AnthropicUsage = {};

  constructor(model?: string | null) {
    super();
    this.model = model ?? null;
  }

  _transform(chunk: Buffer, _enc: string, cb: TransformCallback): void {
    this.buf = Buffer.concat([
      this.buf,
      Buffer.from(stripInvisible(chunk.toString("utf8")), "utf8"),
    ]);
    while (true) {
      const idx = this.buf.indexOf("\n\n");
      if (idx === -1) break;
      const evt = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      this.handleEvent(evt.toString("utf8"));
    }
    cb();
  }

  _flush(cb: TransformCallback): void {
    if (this.buf.length) this.handleEvent(this.buf.toString("utf8"));
    this.buf = Buffer.alloc(0);
    if (this.started && this.finishReason == null) {
      this.emitChunk(
        { finish_reason: "stop" },
        { usage: anthropicUsageToChat(this.anthUsage) },
      );
      this.emitDone();
    }
    cb();
  }

  private emitChunk(
    delta: Record<string, unknown>,
    extra?: Record<string, unknown>,
  ): void {
    const obj: Record<string, unknown> = {
      id: genId("chatcmpl-"),
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.model ?? "",
      choices: [{ index: 0, delta, finish_reason: null }],
    };
    if (extra) Object.assign(obj, extra);
    this.push(`data: ${JSON.stringify(obj)}\n\n`);
  }

  private emitDone(): void {
    this.push("data: [DONE]\n\n");
  }

  private start(): void {
    this.started = true;
    this.emitChunk({ role: "assistant", content: "" });
  }

  private handleEvent(raw: string): void {
    const lines = raw.split("\n");
    let dataStr = "";
    for (const line of lines) {
      if (line.startsWith("data:")) {
        const p = line.slice(5);
        dataStr += p.startsWith(" ") ? p.slice(1) : p;
      }
    }
    if (!dataStr) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataStr);
    } catch {
      return;
    }
    if (!this.started) this.start();
    const type = data.type as string;

    if (type === "message_start") {
      // S2: capture input + cache tokens; message_delta later carries only output.
      const m = data.message as { usage?: AnthropicUsage } | undefined;
      const u = m?.usage;
      if (u && typeof u === "object") {
        this.anthUsage.input_tokens = num(u.input_tokens);
        if (num(u.cache_read_input_tokens) > 0)
          this.anthUsage.cache_read_input_tokens = u.cache_read_input_tokens;
        if (num(u.cache_creation_input_tokens) > 0)
          this.anthUsage.cache_creation_input_tokens =
            u.cache_creation_input_tokens;
      }
      return;
    }

    if (type === "content_block_start") {
      const block = data.content_block as Record<string, unknown> | undefined;
      if (block?.type === "tool_use") {
        const idx = data.index as number;
        const chatIndex = this.nextToolChatIndex++;
        this.toolBlocks.set(idx, {
          chatIndex,
          id: (block.id as string) || genId("call_"),
          name: (block.name as string) ?? "",
        });
        this.emitChunk({
          tool_calls: [
            {
              index: chatIndex,
              id: block.id,
              type: "function",
              function: { name: block.name ?? "", arguments: "" },
            },
          ],
        });
      }
      return;
    }
    if (type === "content_block_delta") {
      const delta = data.delta as Record<string, unknown> | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        this.emitChunk({ content: delta.text });
      } else if (
        delta?.type === "thinking_delta" &&
        typeof delta.thinking === "string"
      ) {
        // S1: Anthropic thinking_delta -> OpenAI reasoning_content delta.
        this.emitChunk({ reasoning_content: delta.thinking });
      } else if (
        delta?.type === "input_json_delta" &&
        typeof delta.partial_json === "string"
      ) {
        const idx = data.index as number;
        const tb = this.toolBlocks.get(idx);
        if (tb) {
          this.emitChunk({
            tool_calls: [
              {
                index: tb.chatIndex,
                function: { arguments: delta.partial_json },
              },
            ],
          });
        }
      }
      return;
    }
    if (type === "message_delta") {
      const d = data.delta as Record<string, unknown> | undefined;
      if (d && typeof d.stop_reason === "string") {
        this.finishReason = STOP_TO_FINISH[d.stop_reason] ?? "stop";
      }
      // S2: message_delta carries output_tokens (and sometimes re-states
      // input/cache). Merge, keeping any cache captured at message_start.
      const u = data.usage as AnthropicUsage | undefined;
      if (u) {
        if (typeof u.output_tokens === "number")
          this.anthUsage.output_tokens = u.output_tokens;
        if (typeof u.input_tokens === "number")
          this.anthUsage.input_tokens = u.input_tokens;
        if (num(u.cache_read_input_tokens) > 0)
          this.anthUsage.cache_read_input_tokens = u.cache_read_input_tokens;
        if (num(u.cache_creation_input_tokens) > 0)
          this.anthUsage.cache_creation_input_tokens =
            u.cache_creation_input_tokens;
      }
      return;
    }
    if (type === "message_stop") {
      this.emitChunk(
        { finish_reason: this.finishReason ?? "stop" },
        { usage: anthropicUsageToChat(this.anthUsage) },
      );
      this.emitDone();
      this.finishReason = this.finishReason ?? "stop";
      return;
    }
  }
}
