// Bridge between the OpenAI Responses API (/v1/responses) and Chat Completions
// API (/v1/chat/completions). Used by the gateway to serve /v1/responses on
// models whose upstream only speaks Chat Completions.
//
// Two directions:
//   requestToChatCompletions  — Responses-shaped client request -> Chat body
//   responseFromChatCompletions — Chat upstream response -> Responses body
//
// Coverage (non-streaming only for now; streaming is a separate piece of work):
//   - Plain-string and item-array inputs (messages, multimodal parts)
//   - instructions -> system message
//   - tools / tool_choice shape (Responses is internally tagged, Chat wraps in
//     { type: 'function', function: {...} })
//   - function_call / function_call_output items <-> assistant tool_calls /
//     role:'tool' messages
//   - text.format (Responses) <-> response_format (Chat) for Structured Outputs
//   - reasoning.effort (Responses) <-> reasoning_effort (Chat)
//   - finish_reason -> status mapping
//   - usage token-field renaming (prompt/completion -> input/output)
//   - reasoning_details from our <thinking> conversion -> reasoning output items
//
// References:
//   https://platform.openai.com/docs/guides/migrate-to-responses

import crypto from "crypto";
import type { ReasoningDetailEntry } from "./thinking";
import { stripInvisible } from "./utils";

// --- Local shape interfaces ----------------------------------------------
// We model only the fields we touch on each side. Bodies on the wire carry
// plenty more; we pass them through opaquely via the index signatures.

interface ChatRequestBody {
  model?: string;
  messages?: ChatMessage[];
  temperature?: number;
  top_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  stop?: unknown;
  seed?: number;
  user?: string;
  parallel_tool_calls?: boolean;
  stream?: boolean;
  logprobs?: boolean;
  top_logprobs?: number;
  max_completion_tokens?: number;
  reasoning_effort?: string;
  response_format?: unknown;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  [k: string]: unknown;
}

interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ChatCompletionResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  system_fingerprint?: string;
  choices?: Array<{
    index?: number;
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments?: string };
      }>;
      annotations?: unknown[];
      reasoning?: string;
      reasoning_details?: ReasoningDetailEntry[];
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: unknown;
    completion_tokens_details?: unknown;
  };
}

interface ResponseOutputItem {
  type: string;
  id?: string;
  role?: string;
  status?: string;
  content?: Array<Record<string, unknown>>;
  summary?: Array<{ type: string; text: string }>;
  call_id?: string;
  name?: string;
  arguments?: string;
  [k: string]: unknown;
}

interface ResponseBody {
  id: string;
  object: "response";
  created_at: number;
  model?: string;
  status: string;
  output: ResponseOutputItem[];
  output_text?: string;
  system_fingerprint?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: unknown;
    output_tokens_details?: unknown;
  };
}

// Short random id with a prefix, OpenAI-style.
function genId(prefix: string): string {
  return prefix + crypto.randomBytes(12).toString("hex");
}

// Map Chat Completions finish_reason -> Responses status.
const FINISH_TO_STATUS: Record<string, string> = {
  stop: "completed",
  length: "incomplete",
  tool_calls: "completed",
  function_call: "completed",
  content_filter: "incomplete",
};

export class ResponsesBridge {
  // --- Request: Responses -> Chat Completions ------------------------------

  // Translate one Responses input item into zero or more Chat messages.
  // Returns an array (almost always 0 or 1 entries; function_call groupings are
  // handled by the caller).
  private inputItemToMessages(
    item: Record<string, unknown>,
  ): Array<ChatMessage | ToolCallItem> {
    if (!item || typeof item !== "object") return [];

    // Items of type 'message' map to a single Chat message.
    if (item.type === "message" || item.role) {
      const role = (item.role as string) || "user";
      const content = this.translateMessageContent(item.content);
      return [{ role, content }];
    }

    // Reasoning items don't have a Chat equivalent. We can't carry encrypted
    // reasoning across the bridge, so drop them. (Reasoning still works for the
    // current turn — it just won't be preserved across multi-turn bridges.)
    if (item.type === "reasoning") return [];

    // function_call items become assistant tool_calls. The caller groups
    // consecutive ones into a single assistant message.
    if (item.type === "function_call") {
      const args = item.arguments;
      return [
        {
          __kind: "tool_call" as const,
          role: "assistant",
          tool_call: {
            id: (item.call_id as string) || genId("call_"),
            type: "function",
            function: {
              name: item.name as string,
              arguments:
                typeof args === "string"
                  ? args
                  : JSON.stringify((args as object) || {}),
            },
          },
        },
      ];
    }

    // function_call_output items become a role:'tool' message.
    if (item.type === "function_call_output") {
      const out = item.output;
      const outStr =
        typeof out === "string" ? out : JSON.stringify((out as unknown) ?? "");
      return [
        {
          role: "tool",
          tool_call_id: item.call_id as string,
          content: outStr,
        },
      ];
    }

    return [];
  }

  // Responses message content can be a string or an array of typed parts.
  // Chat content can also be a string or an array of parts, but with different
  // type tags. Translate the part types.
  private translateMessageContent(content: unknown): unknown {
    if (content == null) return content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return content;

    const parts: Array<Record<string, unknown>> = [];
    for (const partRaw of content) {
      if (!partRaw || typeof partRaw !== "object") continue;
      const part = partRaw as Record<string, unknown>;
      if (
        part.type === "input_text" ||
        part.type === "output_text" ||
        part.type === "text"
      ) {
        parts.push({ type: "text", text: part.text });
      } else if (part.type === "input_image" || part.type === "image") {
        // Responses: { type:'input_image', image_url:'...' | { url } }
        // Chat:      { type:'image_url', image_url:{ url, detail? } }
        const imageUrl = part.image_url;
        const url =
          typeof imageUrl === "string"
            ? imageUrl
            : imageUrl && typeof imageUrl === "object"
              ? ((imageUrl as Record<string, unknown>).url as string)
              : undefined;
        const detail =
          imageUrl && typeof imageUrl === "object"
            ? ((imageUrl as Record<string, unknown>).detail as
                | string
                | undefined)
            : undefined;
        const img: Record<string, unknown> = {
          type: "image_url",
          image_url: detail ? { url, detail } : { url },
        };
        parts.push(img);
      }
      // input_file / audio etc. — drop silently; not portable to Chat.
    }
    return parts;
  }

  // Translate Responses tools (internally tagged) to Chat tools
  // (externally tagged under `function`).
  private translateTools(
    tools: unknown,
  ): Array<Record<string, unknown>> | undefined {
    if (!Array.isArray(tools)) return undefined;
    const out: Array<Record<string, unknown>> = [];
    for (const tRaw of tools) {
      if (!tRaw || typeof tRaw !== "object") continue;
      const t = tRaw as Record<string, unknown>;
      if (t.type === "function") {
        const fn: Record<string, unknown> = {
          name: t.name,
          ...(t.description != null ? { description: t.description } : {}),
          ...(t.parameters != null ? { parameters: t.parameters } : {}),
          ...(t.strict != null ? { strict: t.strict } : {}),
        };
        out.push({ type: "function", function: fn });
      }
      // Hosted tools (web_search, file_search, etc.) aren't expressible in Chat
      // Completions — skip them rather than failing the whole request.
    }
    return out.length ? out : undefined;
  }

  // tool_choice shapes differ slightly for the "pick a specific function" form.
  private translateToolChoice(tc: unknown): unknown {
    if (tc == null) return undefined;
    if (typeof tc === "string") return tc;
    if (typeof tc === "object" && tc !== null) {
      const o = tc as Record<string, unknown>;
      if (o.type === "function" && o.name) {
        return { type: "function", function: { name: o.name } };
      }
      // Auto / none / required pass through.
      return tc;
    }
    return tc;
  }

  // Translate text.format (Responses) -> response_format (Chat).
  // Both wrap a JSON schema as { type:'json_schema', json_schema:{ name, schema, strict } }.
  private translateTextFormat(text: unknown): unknown {
    if (!text || typeof text !== "object") return undefined;
    const t = text as Record<string, unknown>;
    if (t.format != null) return t.format;
    if (t.json_schema != null)
      return { type: "json_schema", json_schema: t.json_schema };
    return undefined;
  }

  requestToChatCompletions(body: Record<string, unknown>): ChatRequestBody {
    if (!body || typeof body !== "object") return body as ChatRequestBody;

    const out: ChatRequestBody = {};

    // --- messages assembly ---
    const messages: ChatMessage[] = [];

    if (typeof body.instructions === "string" && body.instructions) {
      messages.push({ role: "system", content: body.instructions });
    }

    if (typeof body.input === "string") {
      messages.push({ role: "user", content: body.input });
    } else if (Array.isArray(body.input)) {
      // Translate each item. Consecutive function_call items must be grouped
      // into a single assistant message (Chat allows many tool_calls per turn).
      let pendingToolCalls: ToolCallMessage | null = null;
      const flushToolCalls = () => {
        if (pendingToolCalls) {
          messages.push(pendingToolCalls);
          pendingToolCalls = null;
        }
      };

      for (const itemRaw of body.input) {
        const translated = this.inputItemToMessages(
          itemRaw as Record<string, unknown>,
        );
        for (const m of translated) {
          if (isToolCallItem(m)) {
            if (!pendingToolCalls) {
              pendingToolCalls = {
                role: "assistant",
                content: null,
                tool_calls: [],
              };
            }
            pendingToolCalls.tool_calls.push(m.tool_call);
          } else {
            flushToolCalls();
            messages.push(m);
          }
        }
      }
      flushToolCalls();
    }

    out.messages = messages;

    // --- direct passthroughs ---
    if (typeof body.model === "string") out.model = body.model;
    if (body.temperature != null) out.temperature = body.temperature as number;
    if (body.top_p != null) out.top_p = body.top_p as number;
    if (body.presence_penalty != null)
      out.presence_penalty = body.presence_penalty as number;
    if (body.frequency_penalty != null)
      out.frequency_penalty = body.frequency_penalty as number;
    if (body.stop != null) out.stop = body.stop;
    if (body.seed != null) out.seed = body.seed as number;
    if (body.user != null) out.user = body.user as string;
    if (body.parallel_tool_calls != null)
      out.parallel_tool_calls = body.parallel_tool_calls as boolean;
    if (body.stream != null) out.stream = body.stream as boolean;
    if (body.logprobs != null) out.logprobs = body.logprobs as boolean;
    if (body.top_logprobs != null)
      out.top_logprobs = body.top_logprobs as number;

    // --- field renames ---
    if (body.max_output_tokens != null)
      out.max_completion_tokens = body.max_output_tokens as number;

    // reasoning.effort -> reasoning_effort (Chat's flat form)
    const reasoning = body.reasoning as { effort?: string } | undefined;
    if (reasoning && reasoning.effort != null) {
      out.reasoning_effort = reasoning.effort;
    }

    // text.format -> response_format
    const responseFormat = this.translateTextFormat(body.text);
    if (responseFormat) out.response_format = responseFormat;

    // tools / tool_choice
    const tools = this.translateTools(body.tools);
    if (tools) out.tools = tools;
    const toolChoice = this.translateToolChoice(body.tool_choice);
    if (toolChoice != null) out.tool_choice = toolChoice;

    // `store`, `previous_response_id`, `include`, `metadata` have no Chat
    // equivalent — drop them.

    return out;
  }

  // --- Response: Chat Completions -> Responses ------------------------------

  private translateUsage(
    usage: ChatCompletionResponse["usage"],
  ): ResponseBody["usage"] | undefined {
    if (!usage || typeof usage !== "object") return undefined;
    const out: NonNullable<ResponseBody["usage"]> = {};
    if (usage.prompt_tokens != null) out.input_tokens = usage.prompt_tokens;
    if (usage.completion_tokens != null)
      out.output_tokens = usage.completion_tokens;
    if (usage.total_tokens != null) out.total_tokens = usage.total_tokens;
    // Pass through any detailed breakdowns.
    if (usage.prompt_tokens_details)
      out.input_tokens_details = usage.prompt_tokens_details;
    if (usage.completion_tokens_details)
      out.output_tokens_details = usage.completion_tokens_details;
    return out;
  }

  // Build the Responses `output` array from a Chat choice. Emits reasoning
  // items (from reasoning_details), then function_call items (from tool_calls),
  // then the message item. Returns { output, outputText }.
  private choiceToOutput(
    choice: NonNullable<ChatCompletionResponse["choices"]>[number],
  ): {
    output: ResponseOutputItem[];
    outputText: string;
  } {
    const output: ResponseOutputItem[] = [];
    const textParts: string[] = [];
    const msg = choice && choice.message;

    // 1) Reasoning — pull from reasoning_details (set by our <thinking>
    //    conversion) or from a plain `reasoning` string.
    if (msg) {
      const details = Array.isArray(msg.reasoning_details)
        ? msg.reasoning_details
        : [];
      const summaries: Array<{ type: string; text: string }> = [];
      for (const d of details) {
        // Support both the gateway's { type:'reasoning.text', text } shape and
        // OpenAI's { type:'reasoning', summary:[{type:'summary_text', text}] }.
        if (d && d.type === "reasoning.text" && typeof d.text === "string") {
          summaries.push({ type: "summary_text", text: d.text });
        } else if (d && (d as { type?: string }).type === "reasoning") {
          // not our shape; skip
        }
      }
      if (summaries.length) {
        output.push({
          type: "reasoning",
          id: genId("rs_"),
          summary: summaries,
          content: [],
        });
      } else if (typeof msg.reasoning === "string" && msg.reasoning) {
        // Fallback if reasoning_details wasn't set but a raw string was.
        output.push({
          type: "reasoning",
          id: genId("rs_"),
          summary: [{ type: "summary_text", text: msg.reasoning }],
          content: [],
        });
      }
    }

    // 2) Tool calls — each becomes its own function_call output item.
    if (msg && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (!tc || !tc.function) continue;
        output.push({
          type: "function_call",
          id: genId("fc_"),
          call_id: tc.id || genId("call_"),
          name: tc.function.name,
          arguments: tc.function.arguments || "",
        });
      }
    }

    // 3) The message itself, if it has any content (or if there were no tool
    //    calls — keep an empty-content message so output is never empty).
    const hasToolCalls = !!(
      msg &&
      Array.isArray(msg.tool_calls) &&
      msg.tool_calls.length
    );
    const contentText = typeof msg?.content === "string" ? msg.content : "";

    if (contentText || !hasToolCalls) {
      const content: Array<Record<string, unknown>> = [];
      if (contentText) {
        content.push({
          type: "output_text",
          text: contentText,
          annotations: (msg && msg.annotations) || [],
        });
        textParts.push(contentText);
      }
      output.push({
        type: "message",
        id: genId("msg_"),
        status: "completed",
        role: (msg && msg.role) || "assistant",
        content,
      });
    }

    return { output, outputText: textParts.join("") };
  }

  responseFromChatCompletions(
    chatBody: ChatCompletionResponse,
  ): ResponseBody | null {
    if (!chatBody || typeof chatBody !== "object") return null;
    const choice = Array.isArray(chatBody.choices) ? chatBody.choices[0] : null;
    if (!choice) return null;

    const { output, outputText } = this.choiceToOutput(choice);
    const finishReason = choice.finish_reason || "";
    const status = FINISH_TO_STATUS[finishReason] || "completed";

    const resp: ResponseBody = {
      id: genId("resp_"),
      object: "response",
      created_at: chatBody.created || Math.floor(Date.now() / 1000),
      model: chatBody.model,
      status,
      output,
    };

    if (outputText) resp.output_text = outputText;
    if (chatBody.system_fingerprint != null)
      resp.system_fingerprint = chatBody.system_fingerprint;

    const usage = this.translateUsage(chatBody.usage);
    if (usage) resp.usage = usage;

    return resp;
  }
}

// --- Internal helpers for tool-call grouping during request translation ---

interface ToolCallItem {
  __kind: "tool_call";
  role: string;
  tool_call: {
    id: string;
    type: string;
    function: { name: string; arguments: string };
  };
}

interface ToolCallMessage extends ChatMessage {
  tool_calls: NonNullable<ChatMessage["tool_calls"]>;
}

function isToolCallItem(m: ChatMessage | ToolCallItem): m is ToolCallItem {
  return (m as ToolCallItem).__kind === "tool_call";
}

// Exported for tests
export { genId };

// --- Streaming bridge: Chat Completions SSE -> Responses SSE ---------------
//
// Converts a streaming /v1/chat/completions SSE response into /v1/responses
// SSE events. Handles reasoning (from <thinking> conversion), tool calls, and
// content deltas. Each upstream chunk is translated and emitted immediately —
// no buffering beyond what's needed for JSON parsing.
//
// Responses SSE event types emitted:
//   response.created, response.in_progress, response.output_item.added,
//   response.content_block.started, response.content_block.delta,
//   response.content_block.stop, response.output_item.done,
//   response.completed

import { Transform, type TransformCallback } from "stream";

interface ChatCompletionChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  system_fingerprint?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
      reasoning?: string;
      reasoning_details?: Array<{
        type: string;
        text: string;
        format?: string;
        index?: number;
      }>;
      [k: string]: unknown;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: unknown;
    completion_tokens_details?: unknown;
  };
}

export interface ResponsesStreamEvent {
  type: string;
  [k: string]: unknown;
}

export class StreamingResponsesBridgeTransform extends Transform {
  private buffer = Buffer.alloc(0);
  private responseId: string | null = null;
  private created: number | null = null;
  private model: string | null = null;
  private systemFingerprint: string | null = null;
  private outputItemCount = 0;
  private currentBlockIndex = 0;
  private reasoningBlockIndex = -1;
  private reasoningItemId: string | null = null;
  private reasoningOutputIndex = -1;
  private textBlockIndex = -1;
  private textItemId: string | null = null;
  private textOutputIndex = -1;
  private toolCallBlocks = new Map<
    number,
    { index: string; name: string; blockIndex: number; itemId: string; outputIndex: number }
  >();
  private finished = false;
  // Track all output items for correct type/id in output_item.done events
  private outputItems: Array<{ type: string; id: string }> = [];

  constructor() {
    super({ objectMode: false });
  }

  _transform(
    chunk: Buffer,
    _encoding: string,
    callback: TransformCallback,
  ): void {
    const cleaned = Buffer.from(stripInvisible(chunk.toString("utf8")), "utf8");
    this.buffer = Buffer.concat([this.buffer, cleaned]);

    while (true) {
      const idx = this.buffer.indexOf("\n\n");
      if (idx === -1) break;
      const eventBytes = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const raw = eventBytes.toString("utf8");
      this.processEvent(raw);
    }
    callback();
  }

  _flush(callback: TransformCallback): void {
    if (this.buffer.length > 0) {
      this.processEvent(this.buffer.toString("utf8"));
      this.buffer = Buffer.alloc(0);
    }
    // Emit response.completed if not already done
    if (!this.finished) {
      this.closeOpenBlocks();
      this.pushSse({
        type: "response.completed",
        response: this.buildResponse("completed"),
      });
      this.finished = true;
    }
    callback();
  }

  private processEvent(raw: string): void {
    const lines = raw.split("\n");
    let dataStr = "";
    for (const line of lines) {
      if (line.startsWith("data:")) {
        const payload = line.slice(5);
        dataStr += payload.startsWith(" ") ? payload.slice(1) : payload;
      }
    }
    if (!dataStr || dataStr === "[DONE]") {
      if (dataStr === "[DONE]" && !this.finished) {
        this.closeOpenBlocks();
        this.pushSse({
          type: "response.completed",
          response: this.buildResponse("completed"),
        });
        this.finished = true;
      }
      return;
    }

    let chunk: ChatCompletionChunk;
    try {
      chunk = JSON.parse(dataStr);
    } catch {
      return; // non-JSON, skip
    }

    this.translateChunk(chunk);
  }

  private translateChunk(chunk: ChatCompletionChunk): void {
    // First chunk: emit response.created + response.in_progress
    if (!this.responseId) {
      this.responseId = chunk.id || genId("resp_");
      this.created = chunk.created || Math.floor(Date.now() / 1000);
      this.model = chunk.model || null;
      this.systemFingerprint = chunk.system_fingerprint || null;

      this.pushSse({
        type: "response.created",
        response: this.buildResponse("in_progress"),
      });
      this.pushSse({
        type: "response.in_progress",
        response: this.buildResponse("in_progress"),
      });
    }

    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta;
    if (!delta) return;

    // Handle role delta (first chunk often has role only)
    if (delta.role) {
      // Role is set on the message, we'll handle it when content arrives
    }

    // Handle reasoning (from <thinking> conversion) - check all field names
    if (
      delta.reasoning ||
      delta.reasoning_content ||
      delta.reasoning_details?.length
    ) {
      this.handleReasoningDelta(delta);
    }

    // Handle content
    if (typeof delta.content === "string" && delta.content) {
      this.handleContentDelta(delta.content);
    }

    // Handle tool calls
    if (delta.tool_calls?.length) {
      this.handleToolCallDelta(delta.tool_calls);
    }

    // Handle finish
    if (choice.finish_reason) {
      this.handleFinish(choice.finish_reason, chunk.usage);
    }
  }

  private handleReasoningDelta(delta: {
    reasoning?: string;
    reasoning_content?: string;
    reasoning_details?: Array<{ type: string; text: string }>;
  }): void {
    const text =
      delta.reasoning ||
      delta.reasoning_content ||
      delta.reasoning_details?.map((d) => d.text).join("") ||
      "";
    if (!text) return;

    // Open reasoning block if not already open
    if (this.reasoningBlockIndex === -1) {
      this.reasoningBlockIndex = this.currentBlockIndex++;
      this.outputItemCount++;
      this.reasoningItemId = genId("rs_");
      this.reasoningOutputIndex = this.outputItemCount - 1;
      this.outputItems.push({ type: "reasoning", id: this.reasoningItemId });
      this.pushSse({
        type: "response.output_item.added",
        output_index: this.reasoningOutputIndex,
        item: {
          type: "reasoning",
          id: this.reasoningItemId,
          summary: [],
        },
      });
      this.pushSse({
        type: "response.content_part.added",
        item_id: this.reasoningItemId,
        output_index: this.reasoningOutputIndex,
        content_index: 0,
        part: { type: "reasoning_text", text: "" },
      });
    }

    // Emit reasoning delta using correct OpenAI event type
    this.pushSse({
      type: "response.reasoning_text.delta",
      item_id: this.reasoningItemId,
      output_index: this.reasoningOutputIndex,
      content_index: 0,
      delta: text,
    });
  }

  private handleContentDelta(content: string): void {
    // Close reasoning block if open
    if (this.reasoningBlockIndex !== -1) {
      this.pushSse({
        type: "response.content_part.done",
        item_id: this.reasoningItemId,
        output_index: this.reasoningOutputIndex,
        content_index: 0,
        part: { type: "reasoning_text", text: "" },
      });
      this.reasoningBlockIndex = -1;
      this.reasoningItemId = null;
      this.reasoningOutputIndex = -1;
    }

    // Open text block if not already open
    if (this.textBlockIndex === -1) {
      this.textBlockIndex = this.currentBlockIndex++;
      this.outputItemCount++;
      this.textItemId = genId("msg_");
      this.textOutputIndex = this.outputItemCount - 1;
      this.outputItems.push({ type: "message", id: this.textItemId });
      this.pushSse({
        type: "response.output_item.added",
        output_index: this.textOutputIndex,
        item: {
          type: "message",
          id: this.textItemId,
          role: "assistant",
          content: [],
        },
      });
      this.pushSse({
        type: "response.content_part.added",
        item_id: this.textItemId,
        output_index: this.textOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: "" },
      });
    }

    // Emit content delta using correct OpenAI event type
    this.pushSse({
      type: "response.output_text.delta",
      item_id: this.textItemId,
      output_index: this.textOutputIndex,
      content_index: 0,
      delta: content,
    });
  }

  private handleToolCallDelta(
    toolCalls: Array<{
      index?: number;
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>,
  ): void {
    for (const tc of toolCalls) {
      const tcIndex = tc.index ?? 0;
      let block = this.toolCallBlocks.get(tcIndex);

      if (!block) {
        // New tool call
        const blockIndex = this.currentBlockIndex++;
        const itemId = genId("fc_");
        const outputIndex = this.outputItemCount;
        this.outputItemCount++;
        block = {
          index: tc.id || genId("call_"),
          name: tc.function?.name || "",
          blockIndex,
          itemId,
          outputIndex,
        };
        this.toolCallBlocks.set(tcIndex, block);
        this.outputItems.push({ type: "function_call", id: itemId });

        this.pushSse({
          type: "response.output_item.added",
          output_index: outputIndex,
          item: {
            type: "function_call",
            id: itemId,
            call_id: block.index,
            name: block.name,
            arguments: "",
          },
        });
      }

      // Emit argument delta using correct OpenAI event type
      if (tc.function?.arguments) {
        this.pushSse({
          type: "response.function_call_arguments.delta",
          item_id: block.itemId,
          output_index: block.outputIndex,
          delta: tc.function.arguments,
        });
      }
    }
  }

  private closeOpenBlocks(): void {
    // Close any open text block
    if (this.textBlockIndex !== -1) {
      this.pushSse({
        type: "response.content_part.done",
        item_id: this.textItemId,
        output_index: this.textOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: "" },
      });
      this.pushSse({
        type: "response.text.done",
        item_id: this.textItemId,
        output_index: this.textOutputIndex,
        content_index: 0,
      });
      this.textBlockIndex = -1;
      this.textItemId = null;
      this.textOutputIndex = -1;
    }

    // Close any open reasoning block
    if (this.reasoningBlockIndex !== -1) {
      this.pushSse({
        type: "response.content_part.done",
        item_id: this.reasoningItemId,
        output_index: this.reasoningOutputIndex,
        content_index: 0,
        part: { type: "reasoning_text", text: "" },
      });
      this.pushSse({
        type: "response.reasoning_text.done",
        item_id: this.reasoningItemId,
        output_index: this.reasoningOutputIndex,
        content_index: 0,
      });
      this.reasoningBlockIndex = -1;
      this.reasoningItemId = null;
      this.reasoningOutputIndex = -1;
    }

    // Close any open tool call blocks
    for (const [, block] of this.toolCallBlocks) {
      this.pushSse({
        type: "response.function_call_arguments.done",
        item_id: block.itemId,
        output_index: block.outputIndex,
      });
    }
    this.toolCallBlocks.clear();
  }

  private handleFinish(
    finishReason: string,
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      prompt_tokens_details?: unknown;
      completion_tokens_details?: unknown;
    },
  ): void {
    this.closeOpenBlocks();

    // Mark output items as done
    for (let i = 0; i < this.outputItemCount; i++) {
      this.pushSse({
        type: "response.output_item.done",
        output_index: i,
        item: this.buildOutputItem(i),
      });
    }

    // Emit response.completed
    const status = FINISH_TO_STATUS[finishReason] || "completed";
    const response = this.buildResponse(status);
    if (usage) {
      response.usage = {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
        input_tokens_details: usage.prompt_tokens_details,
        output_tokens_details: usage.completion_tokens_details,
      };
    }
    this.pushSse({ type: "response.completed", response });
    this.finished = true;
  }

  private buildResponse(status: string): Record<string, unknown> {
    return {
      id: this.responseId || genId("resp_"),
      object: "response",
      created_at: this.created || Math.floor(Date.now() / 1000),
      model: this.model,
      status,
      output: [],
      system_fingerprint: this.systemFingerprint,
    };
  }

  private buildOutputItem(index: number): Record<string, unknown> {
    const item = this.outputItems[index];
    if (item) {
      return { type: item.type, id: item.id, status: "completed" };
    }
    // Fallback shouldn't happen, but handle gracefully
    return { type: "message", id: genId("msg_"), status: "completed" };
  }

  private pushSse(event: ResponsesStreamEvent): void {
    this.push(`data: ${JSON.stringify(event)}\n\n`);
  }
}
