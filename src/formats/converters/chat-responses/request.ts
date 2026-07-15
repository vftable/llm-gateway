// Buffered request-body conversion: OpenAI Responses (/v1/responses) <->
// Chat Completions (/v1/chat/completions). See the folder's index.ts for the
// full direction/coverage rundown.

import type {
  ResponsesRequest,
  ChatCompletionRequest,
  ChatMessage,
  ChatContentPart,
  ChatTool,
  ChatToolChoice,
} from "../../wire";
import {
  genId,
  isToolCallItem,
  type ToolCallItem,
  type ToolCallMessage,
} from "./shared";

// --- request: Responses -> Chat Completions --------------------------------

// Translate one Responses input item into zero or more Chat messages.
// Returns an array (almost always 0 or 1 entries; function_call groupings are
// handled by the caller).
function inputItemToMessages(
  item: Record<string, unknown>,
): Array<ChatMessage | ToolCallItem> {
  if (!item || typeof item !== "object") return [];

  switch (item.type) {
    case "message":
      return messageItemToMessages(item);

    // Reasoning items have no Chat equivalent and carry encrypted state we
    // can't bridge, so drop them. (Reasoning still works within the current
    // turn — it just isn't preserved across multi-turn bridges.)
    case "reasoning":
      return [];

    // function_call items become assistant tool_calls. The caller groups
    // consecutive ones into a single assistant message.
    case "function_call": {
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
    case "function_call_output": {
      const out = item.output;
      return [
        {
          role: "tool",
          tool_call_id: item.call_id as string,
          content: typeof out === "string" ? out : JSON.stringify(out ?? ""),
        },
      ];
    }

    // A bare item carrying a `role` (no explicit type) is a message too.
    default:
      return item.role ? messageItemToMessages(item) : [];
  }
}

// A 'message' input item (or a bare role-bearing item) -> one Chat message.
function messageItemToMessages(
  item: Record<string, unknown>,
): Array<ChatMessage | ToolCallItem> {
  return [
    {
      role: (item.role as string) || "user",
      content: translateMessageContent(item.content),
    },
  ];
}

// Responses message content can be a string or an array of typed parts.
// Chat content can also be a string or an array of parts, but with different
// type tags. Translate the part types.
function translateMessageContent(content: unknown): ChatMessage["content"] {
  if (content == null) return content as null;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content as ChatContentPart[];

  const parts: ChatContentPart[] = [];
  for (const partRaw of content) {
    if (!partRaw || typeof partRaw !== "object") continue;
    const part = partRaw as Record<string, unknown>;
    if (
      part.type === "input_text" ||
      part.type === "output_text" ||
      part.type === "text"
    ) {
      parts.push({ type: "text", text: String(part.text ?? "") });
    } else if (part.type === "input_image" || part.type === "image") {
      // Responses: { type:'input_image', image_url:'...' | { url } }
      // Chat:      { type:'image_url', image_url:{ url, detail? } }
      const imageUrl = part.image_url;
      const url =
        typeof imageUrl === "string"
          ? imageUrl
          : imageUrl && typeof imageUrl === "object"
            ? ((imageUrl as Record<string, unknown>).url as string)
            : "";
      const detail =
        imageUrl && typeof imageUrl === "object"
          ? ((imageUrl as Record<string, unknown>).detail as string | undefined)
          : undefined;
      parts.push({
        type: "image_url",
        image_url: detail ? { url, detail } : { url },
      });
    }
    // input_file / audio etc. — drop silently; not portable to Chat.
  }
  return parts;
}

// Translate Responses tools (internally tagged) to Chat tools
// (externally tagged under `function`).
function translateTools(tools: unknown): ChatTool[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: ChatTool[] = [];
  for (const tRaw of tools) {
    if (!tRaw || typeof tRaw !== "object") continue;
    const t = tRaw as Record<string, unknown>;
    if (t.type === "function") {
      out.push({
        type: "function",
        function: {
          name: String(t.name ?? ""),
          ...(t.description != null
            ? { description: String(t.description) }
            : {}),
          ...(t.parameters != null ? { parameters: t.parameters } : {}),
          ...(t.strict != null ? { strict: t.strict } : {}),
        },
      });
    }
    // Hosted tools (web_search, file_search, etc.) aren't expressible in Chat
    // Completions — skip them rather than failing the whole request.
  }
  return out.length ? out : undefined;
}

// tool_choice shapes differ slightly for the "pick a specific function" form.
function translateToolChoice(tc: unknown): unknown {
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
function translateTextFormat(text: unknown): unknown {
  if (!text || typeof text !== "object") return undefined;
  const t = text as Record<string, unknown>;
  if (t.format != null) return t.format;
  if (t.json_schema != null)
    return { type: "json_schema", json_schema: t.json_schema };
  return undefined;
}

export function responsesRequestToChat(
  body: ResponsesRequest,
): ChatCompletionRequest {
  if (!body || typeof body !== "object") return body as ChatCompletionRequest;

  const out: ChatCompletionRequest = {};

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
      const translated = inputItemToMessages(
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
  if (body.stop != null) out.stop = body.stop as string | string[];
  if (body.seed != null) out.seed = body.seed as number;
  if (body.user != null) out.user = body.user as string;
  if (body.parallel_tool_calls != null)
    out.parallel_tool_calls = body.parallel_tool_calls as boolean;
  if (body.stream != null) out.stream = body.stream as boolean;
  if (body.logprobs != null) out.logprobs = body.logprobs as boolean;
  if (body.top_logprobs != null) out.top_logprobs = body.top_logprobs as number;
  // metadata exists on both APIs — carry it across rather than dropping it.
  if (body.metadata != null) out.metadata = body.metadata;

  // --- field renames ---
  if (body.max_output_tokens != null)
    out.max_completion_tokens = body.max_output_tokens as number;

  // reasoning.effort -> reasoning_effort (Chat's flat form)
  // reasoning.summary -> _reasoning_summary (gateway-internal, no Chat equivalent)
  const reasoning = body.reasoning as
    { effort?: string; summary?: string } | undefined;
  if (reasoning && reasoning.effort != null) {
    out.reasoning_effort = reasoning.effort;
  }
  if (reasoning && reasoning.summary != null) {
    (out as Record<string, unknown>)._reasoning_summary = reasoning.summary;
  }

  // text.format -> response_format
  const responseFormat = translateTextFormat(body.text);
  if (responseFormat) out.response_format = responseFormat;

  // tools / tool_choice
  const tools = translateTools(body.tools);
  if (tools) out.tools = tools;
  const toolChoice = translateToolChoice(body.tool_choice);
  if (toolChoice != null) out.tool_choice = toolChoice as ChatToolChoice;

  // `store`, `previous_response_id`, `include`, `metadata` have no Chat
  // equivalent — drop them.

  return out;
}

// --- request: Chat Completions -> Responses --------------------------------
// The inverse of responsesRequestToChat() — needed so a chat/messages CLIENT
// can be routed to a responses-NATIVE provider (e.g. OpenAI's GPT-5-class
// models, which preferredEndpoint() pins to /v1/responses). Without this,
// that hop is unsupported and the gateway fails the request over to the next
// provider (or 502s if none remain) even though the upstream is perfectly
// reachable — see preferredEndpoint in providers/catalog/openai.ts. Chat's
// flat message list becomes the Responses `input` item array; a leading
// system message becomes `instructions` (Responses' own slot for it, kept
// separate from `input` like Chat keeps it in `messages`).

// One Chat message -> zero or more Responses input items. An assistant
// message with tool_calls becomes one function_call item per call (Chat
// groups multiple calls under one message; Responses wants each as its own
// item). A role:'tool' message becomes a function_call_output.
function chatMessageToInputItems(
  m: ChatMessage,
): Array<Record<string, unknown>> {
  if (m.role === "tool") {
    return [
      {
        type: "function_call_output",
        call_id: m.tool_call_id ?? "",
        output: typeof m.content === "string" ? m.content : (m.content ?? ""),
      },
    ];
  }
  if (
    m.role === "assistant" &&
    Array.isArray(m.tool_calls) &&
    m.tool_calls.length
  ) {
    const items: Array<Record<string, unknown>> = [];
    // A tool-calling turn may also carry text content alongside the calls
    // (rare, but Chat allows it) — emit the message item first so a
    // round-trip doesn't silently drop that text.
    if (m.content) {
      items.push({
        type: "message",
        role: "assistant",
        content: chatContentToResponsesContent(m.content, "assistant"),
      });
    }
    for (const tc of m.tool_calls) {
      if (!tc.function) continue;
      items.push({
        type: "function_call",
        call_id: tc.id || genId("call_"),
        name: tc.function.name,
        arguments: tc.function.arguments ?? "",
      });
    }
    return items;
  }
  return [
    {
      type: "message",
      role: m.role,
      content: chatContentToResponsesContent(m.content, m.role),
    },
  ];
}

// Chat content (string | ChatContentPart[]) -> Responses content parts.
// Responses tags text differently depending on which side of the
// conversation it's on: input_text/input_image for user/system turns,
// output_text for the assistant's own turns.
function chatContentToResponsesContent(
  content: ChatMessage["content"],
  role: string,
): unknown {
  if (content == null) return content;
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") {
    // A bare string input item is valid Responses shape too, but staying
    // consistent with the typed-part form keeps this symmetric with the
    // array branch below and avoids a second shape callers must handle.
    return [{ type: textType, text: content }];
  }
  if (!Array.isArray(content)) return content;
  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text") {
      parts.push({ type: textType, text: part.text });
    } else if (part.type === "image_url") {
      const imageUrl = (
        part as { image_url?: { url?: string; detail?: string } }
      ).image_url;
      parts.push({
        type: "input_image",
        image_url: imageUrl?.url ?? "",
        ...(imageUrl?.detail ? { detail: imageUrl.detail } : {}),
      });
    }
    // Other part types (already-Responses-shaped passthrough, audio, etc.)
    // aren't portable from Chat's vocabulary — dropped, same policy as the
    // Responses -> Chat direction (translateMessageContent).
  }
  return parts;
}

// Tools: Chat's `{ type:'function', function:{...} }` -> Responses'
// internally-tagged `{ type:'function', name, description, parameters }`.
function chatToolsToResponses(
  tools: unknown,
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const tRaw of tools) {
    if (!tRaw || typeof tRaw !== "object") continue;
    const t = tRaw as ChatTool;
    if (t.type === "function" && t.function) {
      out.push({
        type: "function",
        name: t.function.name,
        ...(t.function.description != null
          ? { description: t.function.description }
          : {}),
        ...(t.function.parameters != null
          ? { parameters: t.function.parameters }
          : {}),
      });
    }
  }
  return out.length ? out : undefined;
}

function chatToolChoiceToResponses(tc: unknown): unknown {
  if (tc == null) return undefined;
  if (typeof tc === "string") return tc;
  if (typeof tc === "object" && tc !== null) {
    const o = tc as Record<string, unknown>;
    if (o.type === "function" && o.function && typeof o.function === "object") {
      const name = (o.function as Record<string, unknown>).name;
      return { type: "function", name };
    }
    return tc;
  }
  return tc;
}

// response_format (Chat) -> text.format (Responses).
function chatResponseFormatToText(
  responseFormat: unknown,
): Record<string, unknown> | undefined {
  if (!responseFormat || typeof responseFormat !== "object") return undefined;
  return { format: responseFormat };
}

export function chatRequestToResponses(
  body: ChatCompletionRequest,
): ResponsesRequest {
  if (!body || typeof body !== "object") return body as ResponsesRequest;

  const out: ResponsesRequest = {};

  const messages = Array.isArray(body.messages) ? body.messages : [];
  // A leading system message maps to Responses' dedicated `instructions`
  // slot (mirroring how responsesRequestToChat treats `instructions` as the
  // one that becomes a system message) — every OTHER message (including a
  // later system message, which Chat allows mid-conversation but Responses
  // has no slot for beyond the first) becomes an `input` item.
  const input: Array<Record<string, unknown>> = [];
  let tookInstructions = false;
  for (const m of messages) {
    if (
      !tookInstructions &&
      m.role === "system" &&
      typeof m.content === "string"
    ) {
      out.instructions = m.content;
      tookInstructions = true;
      continue;
    }
    input.push(...chatMessageToInputItems(m));
  }
  out.input = input;

  if (typeof body.model === "string") out.model = body.model;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stream != null) out.stream = body.stream;
  if (body.parallel_tool_calls != null)
    out.parallel_tool_calls = body.parallel_tool_calls;
  if (body.user != null) out.user = body.user;
  if (body.metadata != null) out.metadata = body.metadata;

  // max_completion_tokens (or the older max_tokens) -> max_output_tokens.
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens != null) out.max_output_tokens = maxTokens;

  // reasoning_effort (Chat's flat form) -> reasoning.effort
  // _reasoning_summary (gateway-internal) -> reasoning.summary
  const chatBody = body as Record<string, unknown>;
  const reasoningSummary = chatBody._reasoning_summary as string | undefined;
  if (body.reasoning_effort != null || reasoningSummary != null) {
    const r: Record<string, unknown> = {};
    if (body.reasoning_effort != null) r.effort = body.reasoning_effort;
    if (reasoningSummary != null) r.summary = reasoningSummary;
    out.reasoning = r;
  }

  // response_format -> text.format
  const text = chatResponseFormatToText(body.response_format);
  if (text) out.text = text;

  // tools / tool_choice
  const tools = chatToolsToResponses(body.tools);
  if (tools) out.tools = tools;
  const toolChoice = chatToolChoiceToResponses(body.tool_choice);
  if (toolChoice != null) out.tool_choice = toolChoice;

  // `seed`, `presence_penalty`, `frequency_penalty`, `stop`, `logprobs`,
  // `top_logprobs` have no Responses equivalent — drop them, same policy
  // (silently skip untranslatable fields) as the reverse direction.

  return out;
}
