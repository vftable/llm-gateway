// Buffered (non-streaming) response conversion: OpenAI Chat Completions <->
// Responses (/v1/responses). See the folder's index.ts for the full
// direction/coverage rundown.

import type {
  ResponsesResponse,
  ChatCompletionResponse,
  ChatMessage,
  ChatReasoningDetail,
  ChatToolCall,
  ChatUsage,
} from "../../wire";
import {
  genId,
  FINISH_TO_STATUS,
  STATUS_TO_FINISH,
  type ResponseOutputItem,
  type ResponseBody,
} from "./shared";

// --- response: Chat Completions -> Responses -------------------------------

function translateUsage(
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
function choiceToOutput(
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

export function chatResponseToResponses(
  chatBody: ChatCompletionResponse,
): ResponsesResponse | null {
  if (!chatBody || typeof chatBody !== "object") return null;
  const choice = Array.isArray(chatBody.choices) ? chatBody.choices[0] : null;
  if (!choice) return null;

  const { output, outputText } = choiceToOutput(choice);
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

  const usage = translateUsage(chatBody.usage);
  if (usage) resp.usage = usage;

  // Local ResponseBody (required fields) is assignable to the wire
  // ResponsesResponse (optional-field passthrough overlay).
  return resp;
}

// --- response: Responses -> Chat Completions -------------------------------
// The inverse of chatResponseToResponses() — the buffered half of serving a
// chat/messages CLIENT off a responses-native provider (paired with
// chatRequestToResponses() for the request side).

function usageFromResponses(
  usage: ResponsesResponse["usage"],
): ChatUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const out: ChatUsage = {};
  if (usage.input_tokens != null) out.prompt_tokens = usage.input_tokens;
  if (usage.output_tokens != null) out.completion_tokens = usage.output_tokens;
  if (usage.total_tokens != null) out.total_tokens = usage.total_tokens;
  if (usage.input_tokens_details)
    out.prompt_tokens_details =
      usage.input_tokens_details as ChatUsage["prompt_tokens_details"];
  if (usage.output_tokens_details)
    out.completion_tokens_details = usage.output_tokens_details;
  return out;
}

// Build a Chat message + finish_reason from a Responses `output` array —
// the inverse of choiceToOutput(). Reasoning items become reasoning_details
// (round-tripping through the SAME { type:'reasoning.text', text } shape our
// own <thinking> extraction uses, so a reasoning->chat->reasoning round trip
// is lossless); function_call items become tool_calls; the message item's
// content becomes the message text.
function outputToMessage(output: ResponseOutputItem[]): {
  message: ChatMessage;
  finishReason: string;
} {
  const reasoningDetails: ChatReasoningDetail[] = [];
  const toolCalls: ChatToolCall[] = [];
  let content = "";
  let role = "assistant";

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "reasoning" && Array.isArray(item.summary)) {
      const text = item.summary.map((s) => s.text ?? "").join("");
      if (text) reasoningDetails.push({ type: "reasoning.text", text });
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id || genId("call_"),
        type: "function",
        function: {
          name: item.name ?? "",
          arguments: typeof item.arguments === "string" ? item.arguments : "",
        },
      });
    } else if (item.type === "message") {
      role = item.role || "assistant";
      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (
            part &&
            typeof part === "object" &&
            typeof (part as { text?: unknown }).text === "string"
          ) {
            content += (part as { text: string }).text;
          }
        }
      }
    }
    // function_call_output items only ever appear on the REQUEST side
    // (they're how a client supplies a tool result back to the model) —
    // never in a model-generated `output` array, so there's nothing to
    // translate for them here.
  }

  const message: ChatMessage = { role, content: content || null };
  if (reasoningDetails.length) message.reasoning_details = reasoningDetails;
  if (toolCalls.length) message.tool_calls = toolCalls;

  const finishReason = toolCalls.length ? "tool_calls" : "stop";
  return { message, finishReason };
}

export function responsesResponseToChat(
  body: ResponsesResponse,
): ChatCompletionResponse | null {
  if (!body || typeof body !== "object") return null;
  const output = Array.isArray(body.output) ? body.output : [];

  const { message, finishReason } = outputToMessage(output);
  // STATUS_TO_FINISH only overrides for "incomplete" (length-truncated) —
  // every other status is re-derived from output contents above, since the
  // status alone can't distinguish "stopped after text" from "stopped after
  // a tool call" (see the comment on STATUS_TO_FINISH).
  const finish =
    body.status && STATUS_TO_FINISH[body.status]
      ? STATUS_TO_FINISH[body.status]
      : finishReason;

  const out: ChatCompletionResponse = {
    id: body.id ?? genId("chatcmpl_"),
    object: "chat.completion",
    created: body.created_at ?? Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [{ index: 0, message, finish_reason: finish }],
  };
  if (body.system_fingerprint != null)
    out.system_fingerprint = body.system_fingerprint;

  const usage = usageFromResponses(body.usage);
  if (usage) out.usage = usage;

  return out;
}
