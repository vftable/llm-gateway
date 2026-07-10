// Buffered (non-streaming) response conversion: OpenAI Chat Completions <->
// Anthropic Messages. See the folder's index.ts for the full direction/
// coverage rundown.

import type {
  AnthropicMessagesResponse,
  AnthropicUsage,
  ChatCompletionResponse,
  ChatMessage as WireChatMessage,
} from "../../wire";
import { SYNTHETIC_THINKING_SIGNATURE } from "../../wire/anthropic";
import {
  genId,
  safeParse,
  extractReasoningText,
  FINISH_TO_STOP,
  STOP_TO_FINISH,
  anthropicUsageToChat,
  chatUsageToAnthropic,
  type AnthropicBlock,
} from "./shared";

// --- response: OpenAI Chat -> Anthropic Messages (non-streaming) -----------

export function chatResponseToMessages(
  chat: ChatCompletionResponse,
): AnthropicMessagesResponse {
  const choices =
    (chat.choices as Array<Record<string, unknown>> | undefined) ?? [];
  const choice = choices[0] ?? {};
  const msg = (choice.message as Record<string, unknown> | undefined) ?? {};
  const content: AnthropicBlock[] = [];

  // S1: OpenAI reasoning_content -> leading Anthropic thinking block.
  // `signature` is required shape (real Anthropic thinking blocks always
  // carry one) but this text came from an OpenAI-shaped provider, so there's
  // no genuine signature to attach — see SYNTHETIC_THINKING_SIGNATURE's doc
  // comment. Every request that forwards this upstream runs
  // stripUnsupportedThinking first, which converts it back to plain text.
  const reasoning = extractReasoningText(msg);
  if (reasoning)
    content.push({
      type: "thinking",
      thinking: reasoning,
      signature: SYNTHETIC_THINKING_SIGNATURE,
    });

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
  msgBody: AnthropicMessagesResponse,
): ChatCompletionResponse {
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
  const message: WireChatMessage = { role: "assistant" };
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
