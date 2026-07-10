// Buffered request-body conversion: Anthropic Messages <-> OpenAI Chat
// Completions. See the folder's index.ts for the full direction/coverage
// rundown.

import type {
  AnthropicMessagesRequest,
  ChatCompletionRequest,
} from "../../wire";
import {
  genId,
  sanitizeToolId,
  safeParse,
  anthropicContentToChat,
  chatContentToAnthropic,
  anthropicToolsToChat,
  chatToolsToAnthropic,
  anthropicToolChoiceToChat,
  chatToolChoiceToAnthropic,
  type AnthropicBlock,
  type ChatContentPart,
} from "./shared";

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
  body: AnthropicMessagesRequest,
): ChatCompletionRequest {
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
  body: ChatCompletionRequest,
): AnthropicMessagesRequest {
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
        typeof m.content === "string" ? m.content : extractChatText(m.content);
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
    systemText = systemText
      ? `${systemText}\n${jsonInstruction}`
      : jsonInstruction;

  if (systemText) out.system = systemText;
  out.messages = normalized;
  if (typeof body.model === "string") out.model = body.model;
  if (typeof body.max_tokens === "number") out.max_tokens = body.max_tokens;
  else if (typeof body.max_completion_tokens === "number")
    out.max_tokens = body.max_completion_tokens;
  // temperature: OpenAI Chat allows 0.0–2.0; Anthropic Messages only 0.0–1.0 and
  // 400s outside that. Clamp so a Chat client sending e.g. 1.5 doesn't fail.
  // https://platform.claude.com/docs/en/api/messages (temperature 0.0–1.0)
  if (typeof body.temperature === "number")
    out.temperature = Math.max(0, Math.min(1, body.temperature));
  else if (body.temperature != null) out.temperature = body.temperature;
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
