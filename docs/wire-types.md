# Wire types reference

This document is the field-by-field reference for the TypeScript types
modeling **OpenAI Chat Completions**, **OpenAI Responses**, and **Anthropic
Messages** wire bodies — the shapes a transform's `body`/`event` argument (or
an adapter build method's `ctx.body`) is actually typed as. It complements
the other docs rather than repeating them:

- [`docs/transforms-api.md`](./transforms-api.md) — how a transform is
  *authored* (`onRequest`/`onResponse`/`onStreamEvent`), how `TransformCtx`
  works, and how the type these functions infer connects to the tables here.
- [`docs/provider-adapters.md`](./provider-adapters.md) — how a build method
  (`chatCompletions`/`messages`/`responses`) receives `ctx.body` already
  converted to the provider's wire format, and assembles the final outbound
  request around it.
- [`docs/format-conversion.md`](./format-conversion.md) — the *behavioral*
  quirks of converting between these shapes (id sanitization, tool-response
  insertion, etc.) — this document only covers *what fields exist*, not how
  they're translated.

**Quick links:** [where the types live](#where-the-types-live) ·
[the three formats + how a handler's type is inferred](#the-three-formats--how-a-handlers-type-is-inferred) ·
[modeling philosophy](#modeling-philosophy-typed-fields--index-signature-passthrough) ·
[OpenAI Chat Completions](#openai-chat-completions-chat) ·
[OpenAI Responses](#openai-responses-responses) ·
[Anthropic Messages](#anthropic-messages-messages) ·
[model-list types](#model-list-types-get-v1models) ·
[supporting types](#supporting-types) ·
[quick reference table](#quick-reference-every-exported-type-by-file)

---

## Where the types live

```
src/formats/wire/
  index.ts             — barrel (`export * from` the three format files + models.ts),
                          WireFmt / WireRequest<F> / WireResponse<F> / WireStreamEvent<F>
  openai-chat.ts        — ChatCompletionRequest / ChatCompletionResponse / ChatCompletionChunk
                          + every nested type (ChatMessage, ChatToolCall, …)
  openai-responses.ts   — ResponsesRequest / ResponsesResponse / ResponsesStreamEvent
                          + every nested type (ResponsesInputItem, ResponseOutputItem, …)
  anthropic.ts          — AnthropicMessagesRequest / AnthropicMessagesResponse /
                          AnthropicStreamEvent + every nested type (AnthropicBlock, …)
  models.ts             — OpenAIModel(List) / AnthropicModel(List) / UpstreamModel —
                          the separate GET /v1/models shapes (see below)
src/formats/thinking/
  converter.ts          — ReasoningDetailEntry (the concrete shape the gateway writes
                          into ChatMessage.reasoning_details / ChatDelta.reasoning_details)
src/types/capabilities.ts — ModelCapabilities (surfaced on AnthropicModel/UpstreamModel,
                          unrelated to request/response bodies)
```

Every type in `formats/wire/` is a **plain TypeScript interface** — nothing
here is a runtime schema, validator, or class. They exist purely so code that
reads/writes a wire body gets autocomplete and compile-time field-name
checking instead of `body.messagse` silently typo-ing into `unknown`.

---

## The three formats + how a handler's type is inferred

The gateway understands three wire formats, identified by the `WireFmt`
string union (`"chat" | "messages" | "responses"`):

| `WireFmt` | API | Endpoint | Native to |
|---|---|---|---|
| `"chat"` | OpenAI Chat Completions | `/v1/chat/completions` | Most OpenAI-compatible providers (`openai`, `deepseek`, `glm`, `openrouter`, the generic `openai-compatible` catalog entry, …) |
| `"messages"` | Anthropic Messages | `/v1/messages` | Anthropic-native providers (`anthropic`, `claude-code`, `anthropic-compatible`) |
| `"responses"` | OpenAI Responses | `/v1/responses` | OpenAI's newer stateful/reasoning-first API — some adapters prefer it per model (see `preferredEndpoint` in provider-adapters.md) |

Three generic mapping types (`formats/wire/index.ts`) tie a `WireFmt` literal
to its concrete request / non-streaming-response / streaming-event type:

```ts
type WireRequest<F extends WireFmt> = F extends "chat"
  ? ChatCompletionRequest
  : F extends "messages"
    ? AnthropicMessagesRequest
    : ResponsesRequest;

type WireResponse<F extends WireFmt> = F extends "chat"
  ? ChatCompletionResponse
  : F extends "messages"
    ? AnthropicMessagesResponse
    : ResponsesResponse;

type WireStreamEvent<F extends WireFmt> = F extends "chat"
  ? ChatCompletionChunk
  : F extends "messages"
    ? AnthropicStreamEvent
    : ResponsesStreamEvent;
```

This is what makes `onRequest`/`onResponse`/`onStreamEvent`
(`formats/pipeline.ts`, authored in full in
[transforms-api.md](./transforms-api.md#authoring-a-transform-onrequest--onresponse--onstreamevent))
give you a real type instead of `Record<string, unknown>` — the literal you
pass as the first argument selects the type the handler's `body`/`event`
parameter is inferred as:

```ts
import { onRequest, onResponse, onStreamEvent } from "../../formats/pipeline";

// body: ChatCompletionRequest
onRequest("chat", "my:example", (body, ctx) => {
  body.temperature ??= 0.2;       // ChatCompletionRequest field, autocompletes
  return body;
});

// body: AnthropicMessagesResponse
onResponse("messages", "my:example", (body, ctx) => {
  body.stop_reason;               // AnthropicMessagesResponse field
  return body;
});

// event: ChatCompletionChunk
onStreamEvent("chat", "my:example", (event, ctx) => {
  return event.choices?.[0]?.delta?.content ? event : null;
});
```

The same inference happens for a provider adapter's **own**
`requestTransforms()`/`responseTransforms()`/`streamTransforms()` overrides
(they return the exact same `TaggedRequestTransform`/etc. shapes — see
`catalog/example-custom.ts`), and for `probeEndpoint()`'s `opts.body`
parameter (typed `WireRequest<K>` from the `kind` you pass — see
[provider-adapters.md](./provider-adapters.md#testmodelctx--testmodelctx-promisetestmodelresult)),
so a hand-built probe body gets the same field checking as a live request.

An adapter **build method** (`chatCompletions`/`messages`/`responses` on
`ProviderAdapter` — see
[provider-adapters.md](./provider-adapters.md#the-model-catalog-metadata--routing-behavior-on-one-object))
receives `ctx.body: Record<string, unknown>` — **untyped**, because by build
time the body has already been converted to the provider's wire format but
`BuildCtx` is one shape shared across all three kinds (it doesn't know which
kind *this* hop resolved to at the type level, only at the value level via
`ctx.providerFmt`/`ctx.endpointKind`). Narrow it yourself if you need typed
field access inside a build method:

```ts
import type { ChatCompletionRequest } from "../../formats/wire";

chatCompletions(ctx: BuildCtx): BuiltRequest {
  const body = ctx.body as ChatCompletionRequest; // safe: this method only
                                                    // ever runs for the chat kind
  body.temperature ??= 0.7;
  return { url: ctx.url, headers: ctx.headers, body };
}
```

---

## Modeling philosophy: typed fields + index-signature passthrough

None of these interfaces are exhaustive schemas. Every one of them —
top-level and nested — models **only the fields the gateway actually reads or
writes**, plus a `[k: string]: unknown` index signature that keeps every
other field the upstream/client sent riding through untouched:

```ts
export interface ChatMessage {
  role: string;
  content?: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning?: string;
  reasoning_content?: string;
  reasoning_details?: ChatReasoningDetail[];
  [k: string]: unknown;   // <- everything else: `annotations`, `refusal`, whatever
                          //    a specific upstream tacks on, survives round-trip
}
```

Two consequences worth knowing before you write a transform:

- **A field you don't see in these tables still exists on the object** — you
  just don't get autocomplete/type-checking for it. Reading/writing it works
  fine (`(body as Record<string, unknown>).some_vendor_field`), it's simply
  outside what's modeled.
- **A union type's discriminated members are not exhaustive either.** E.g.
  `AnthropicBlock` is `AnthropicTextBlock | AnthropicImageBlock | … |
  Record<string, unknown>` — that trailing bare-object member means any block
  shape the gateway doesn't specifically model (or a brand-new Anthropic
  block type added upstream tomorrow) still type-checks as an `AnthropicBlock`,
  it just narrows to `Record<string, unknown>` instead of a named interface.
  This is deliberate: a passthrough union that only accepted its named
  members would reject valid upstream data the gateway hasn't been taught
  about yet.

Extend an interface (add a field) rather than replacing it wholesale when a
transform needs a field that isn't modeled yet and you want the type
checking — that's a small, additive PR to the relevant `formats/wire/*.ts`
file. You never *have* to do this; the index signature already lets you read
the field with a cast.

---

## OpenAI Chat Completions (`chat`)

`src/formats/wire/openai-chat.ts` — `/v1/chat/completions`. Applies to
`ChatCompletionRequest` (request), `ChatCompletionResponse` (buffered
response), and `ChatCompletionChunk` (one streamed SSE event, `chat`-tagged
`onStreamEvent` handlers).

### Content + tools

| Type | Fields | Notes |
|---|---|---|
| `ChatTextPart` | `type: "text" \| "input_text" \| "output_text"`, `text: string` | One member of `ChatContentPart` — a multi-part message's plain-text piece |
| `ChatImagePart` | `type: "image_url"`, `image_url: { url: string; detail?: string }` | The other named `ChatContentPart` member |
| `ChatContentPart` | `ChatTextPart \| ChatImagePart \| ({ type: string } & Record<string, unknown>)` | A `ChatMessage.content` array element — open union, see [modeling philosophy](#modeling-philosophy-typed-fields--index-signature-passthrough) |
| `ChatToolCall` | `id: string`, `type: "function" \| string`, `function: { name: string; arguments?: string }`, `index?: number` | `arguments` is a **JSON string**, not a parsed object — and optional because a streaming delta's opening chunk often omits it. `index` is set on streaming deltas only (position in the tool-call array being assembled) |
| `ChatReasoningDetail` | `type?: string`, `text?: string`, `format?: string`, `index?: number`, `summary?: Array<{ type?: string; text?: string }>` | Modeled loosely — see [Reasoning fields](#reasoning-fields-chatmessagereasoning_details--anthropic-thinking-blocks) below for the concrete shape the gateway itself writes |
| `ChatMessage` | `role: string`, `content?: string \| ChatContentPart[] \| null`, `tool_calls?: ChatToolCall[]`, `tool_call_id?: string`, `name?: string`, `reasoning?: string`, `reasoning_content?: string`, `reasoning_details?: ChatReasoningDetail[]` | The converters set `content: null` (not `undefined`, not omitted) whenever a converted assistant turn has no text — including a pure-tool-call turn (Anthropic tool-use blocks carry no accompanying text) — so `content === null` is a real, expected state to handle, distinct from "field absent." The three `reasoning*` fields are gateway-attached (from `<thinking>` extraction / cross-format bridging), not sent by every upstream |
| `ChatTool` | `type: "function" \| string`, `function: { name: string; description?: string; parameters?: unknown }` | One entry in `ChatCompletionRequest.tools` |
| `ChatToolChoice` | `"auto" \| "none" \| "required" \| { type: "function"; function: { name: string } } \| ({ type: string } & Record<string, unknown>)` | `ChatCompletionRequest.tool_choice` |

### Usage

| Type | Fields |
|---|---|
| `ChatUsage` | `prompt_tokens?: number`, `completion_tokens?: number`, `total_tokens?: number`, `prompt_tokens_details?: { cached_tokens?: number; cache_creation_tokens?: number }`, `completion_tokens_details?: unknown` |

### Request — `ChatCompletionRequest`

| Field | Type | Notes |
|---|---|---|
| `model` | `string` | Stamped with the **upstream** model id by the engine before the build phase runs — a transform sees whatever the client sent |
| `messages` | `ChatMessage[]` | |
| `temperature` / `top_p` / `top_k` | `number` | `top_k` isn't part of OpenAI's own schema but rides through for OpenAI-compatible upstreams that accept it (vLLM, etc.) |
| `max_tokens` / `max_completion_tokens` | `number` | Two historical names for the same concept across OpenAI API generations |
| `presence_penalty` / `frequency_penalty` | `number` | |
| `stop` | `string \| string[]` | |
| `seed` | `number` | |
| `user` | `string` | |
| `stream` | `boolean` | Whether the client asked for SSE — the engine already knows this before any transform runs (`ForwardContext.isStream`, set from the inbound request), so a transform never needs to branch on this field to know which pipeline path it's in |
| `logprobs` | `boolean` | |
| `top_logprobs` | `number` | |
| `parallel_tool_calls` | `boolean` | |
| `reasoning_effort` | `unknown` | Untyped — see [Reasoning fields](#reasoning-fields-chatmessagereasoning_details--anthropic-thinking-blocks) |
| `response_format` | `unknown` | JSON-schema/JSON-object response constraint — see `docs/format-conversion.md` R3 for how this maps to Anthropic (no native equivalent, becomes a system instruction) |
| `metadata` | `unknown` | |
| `tools` | `ChatTool[]` | |
| `tool_choice` | `ChatToolChoice` | |

### Response (non-streaming)

```ts
interface ChatChoice {
  index?: number;
  message?: ChatMessage;
  finish_reason?: string | null;
}
interface ChatCompletionResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  system_fingerprint?: string;
  choices?: ChatChoice[];
  usage?: ChatUsage;
}
```

### Streaming chunk

```ts
interface ChatDelta {
  role?: string;
  content?: string;
  tool_calls?: Array<{
    index?: number; id?: string; type?: string;
    function?: { name?: string; arguments?: string };
  }>;
  reasoning?: string;
  reasoning_content?: string;
  reasoning_details?: ChatReasoningDetail[];
}
interface ChatChunkChoice {
  index?: number;
  delta?: ChatDelta;
  finish_reason?: string | null;
}
interface ChatCompletionChunk {
  id?: string;
  object?: "chat.completion.chunk" | string;
  created?: number;
  model?: string;
  system_fingerprint?: string;
  choices?: ChatChunkChoice[];
  usage?: ChatUsage;
}
```

`ChatDelta.tool_calls` is a **separate, inline-typed** shape from
`ChatToolCall` (same fields, but `function` isn't the named `ChatToolCall`
interface) — this mirrors how a real streaming tool-call delta only ever
carries a *fragment* of the final call (accumulated client-side across
multiple chunks by `index`), so treating it as the same type as a
complete `ChatToolCall` would be misleading.

---

## OpenAI Responses (`responses`)

`src/formats/wire/openai-responses.ts` — `/v1/responses`. Applies to
`ResponsesRequest`, `ResponsesResponse`, and `ResponsesStreamEvent`.

This is OpenAI's newer, item-based API — a request's `input` is either a
plain string or an **array of typed items** (message / function call /
function output / reasoning), rather than Chat's flat `messages` array with
inline tool-call fields.

### Input items

| Type | `type` discriminant | Fields |
|---|---|---|
| `ResponsesMessageItem` | `"message"` | `role: string`, `content?: unknown` |
| `ResponsesFunctionCallItem` | `"function_call"` | `call_id?: string`, `name?: string`, `arguments?: unknown` |
| `ResponsesFunctionCallOutputItem` | `"function_call_output"` | `call_id?: string`, `output?: unknown` |
| `ResponsesReasoningItem` | `"reasoning"` | `id?: string`, `summary?: Array<{ type: string; text: string }>`, `encrypted_content?: string`, `content?: unknown[]`, `status?: string` — `encrypted_content` is an opaque base64 blob for multi-turn continuity; `content` is usually `[]`; `summary` carries the human-readable reasoning text |
| `ResponsesInputItem` | *(union of the four above)* | `\| ({ type?: string } & Record<string, unknown>)` — open union, an unrecognized item type still type-checks |

### Usage

| Type | Fields |
|---|---|
| `ResponsesUsage` | `input_tokens?: number`, `output_tokens?: number`, `total_tokens?: number`, `input_tokens_details?: unknown`, `output_tokens_details?: unknown` |

### Request — `ResponsesRequest`

| Field | Type | Notes |
|---|---|---|
| `model` | `string` | |
| `input` | `string \| ResponsesInputItem[]` | A plain string is shorthand for a single user message |
| `instructions` | `string` | Responses' equivalent of a system prompt |
| `temperature` / `top_p` | `number` | |
| `max_output_tokens` | `number` | Responses' name for Chat's `max_tokens` |
| `stream` | `boolean` | |
| `parallel_tool_calls` | `boolean` | |
| `reasoning` | `{ effort?: unknown; summary?: string }` | `effort`: reasoning intensity (`low`/`medium`/`high`/…); `summary`: whether to include reasoning summaries in the response (`"auto"` / `"concise"` / `"detailed"`). See [Reasoning fields](#reasoning-fields-chatmessagereasoning_details--anthropic-thinking-blocks) |
| `text` | `{ format?: unknown }` | Responses' structured-output configuration |
| `tools` | `Array<Record<string, unknown>>` | Untyped per-entry — Responses' tool schema differs enough from Chat's that this file doesn't model individual fields |
| `tool_choice` | `unknown` | |
| `metadata` | `unknown` | |
| `user` | `string` | |

### Response (non-streaming)

```ts
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
}
interface ResponsesResponse {
  id?: string;
  object?: "response";
  created_at?: number;
  model?: string;
  status?: string;
  output?: ResponseOutputItem[];
  output_text?: string;
  system_fingerprint?: string;
  usage?: ResponsesUsage;
}
```

`ResponseOutputItem` is a single loosely-typed shape covering every kind of
output item (message, function call, reasoning, …) rather than a
discriminated union like `ResponsesInputItem` — narrow on `.type` yourself
when you need to branch (`"message"` / `"function_call"` / `"reasoning"` /
etc.).

### Streaming events

Discriminated by `type`, which uses **dotted names** unlike Chat's flat
event shape:

```ts
interface ResponsesStreamEventBase { type: string; }

interface ResponsesCreatedEvent extends ResponsesStreamEventBase {
  type: "response.created" | "response.in_progress" | "response.completed";
  response?: Partial<ResponsesResponse>;
}
interface ResponsesOutputItemEvent extends ResponsesStreamEventBase {
  type: "response.output_item.added" | "response.output_item.done";
  output_index?: number;
  item?: ResponseOutputItem;
}
interface ResponsesContentPartEvent extends ResponsesStreamEventBase {
  type: "response.content_part.added" | "response.content_part.done";
  item_id?: string; output_index?: number; content_index?: number;
  part?: Record<string, unknown>;
}
interface ResponsesTextDeltaEvent extends ResponsesStreamEventBase {
  type: "response.output_text.delta" | "response.text.done";
  item_id?: string; output_index?: number; content_index?: number;
  delta?: string; text?: string;
}
interface ResponsesReasoningTextEvent extends ResponsesStreamEventBase {
  type: "response.reasoning_text.delta" | "response.reasoning_text.done";
  item_id?: string; output_index?: number;
  delta?: string; text?: string;
}
interface ResponsesReasoningSummaryTextEvent extends ResponsesStreamEventBase {
  type: "response.reasoning_summary_text.delta"
      | "response.reasoning_summary_text.done";
  item_id?: string; output_index?: number;
  summary_index?: number; content_index?: number;
  delta?: string; text?: string;
}
interface ResponsesFunctionArgsEvent extends ResponsesStreamEventBase {
  type: "response.function_call_arguments.delta"
      | "response.function_call_arguments.done";
  item_id?: string; output_index?: number;
  delta?: string; arguments?: string;
}

type ResponsesStreamEvent =
  | ResponsesCreatedEvent | ResponsesOutputItemEvent
  | ResponsesContentPartEvent | ResponsesTextDeltaEvent
  | ResponsesReasoningTextEvent | ResponsesReasoningSummaryTextEvent
  | ResponsesFunctionArgsEvent
  | ResponsesStreamEventBase;   // fallback: any other event type still type-checks
```

Every event pairs a `.delta` (incremental, streamed) variant with a `.done`
(final, complete value) variant of the same field — e.g.
`response.output_text.delta` streams `delta` chunks, `response.text.done`
carries the full `text` once assembled.

---

## Anthropic Messages (`messages`)

`src/formats/wire/anthropic.ts` — `/v1/messages`. Applies to
`AnthropicMessagesRequest`, `AnthropicMessagesResponse`, and
`AnthropicStreamEvent`.

### Content blocks

| Type | `type` discriminant | Fields | Notes |
|---|---|---|---|
| `AnthropicTextBlock` | `"text"` | `text: string`, `cache_control?: { type: "ephemeral"; ttl?: string } \| null` | `cache_control` is how prompt-caching breakpoints are marked (see `anthropic-cache` in [transforms-api.md § The user-configurable transform library](./transforms-api.md#the-user-configurable-transform-library-formatstransformsregistryts)) |
| `AnthropicImageBlock` | `"image" \| "input_image"` | `source?: { type: "base64" \| "url"; media_type?: string; data?: string; url?: string }`, `url?: string` | |
| `AnthropicToolUseBlock` | `"tool_use"` | `id: string`, `name: string`, `input: unknown` | `id` must match `^[a-zA-Z0-9_-]+$` — see format-conversion.md R1 |
| `AnthropicToolResultBlock` | `"tool_result"` | `tool_use_id: string`, `content?: unknown`, `is_error?: boolean` | |
| `AnthropicThinkingBlock` | `"thinking" \| "redacted_thinking"` | `thinking?: string`, `signature?: string`, `data?: string` | See [Reasoning fields](#reasoning-fields-chatmessagereasoning_details--anthropic-thinking-blocks) and `SYNTHETIC_THINKING_SIGNATURE` below — this is the block type the gateway's Anthropic request hooks strip on every request before it can reach a real upstream |
| `AnthropicDocumentBlock` | `"document"` | `source?: { type: "base64" \| "url"; media_type?: string; data?: string; url?: string }` | PDF documents — see format-conversion.md R4 for the OpenAI `file` → this mapping (PDF only) |
| `AnthropicBlock` | *(union of all six above)* | `\| Record<string, unknown>` | Open union — see [modeling philosophy](#modeling-philosophy-typed-fields--index-signature-passthrough) |

#### `SYNTHETIC_THINKING_SIGNATURE`

```ts
export const SYNTHETIC_THINKING_SIGNATURE = "llmapi-synthetic-thinking";
```

A real Anthropic `thinking` block always carries a cryptographic
`signature`; Anthropic rejects an echoed-back block with a missing/invalid
one. When the gateway **synthesizes** a thinking block itself (extracting
inline `<thinking>` tags from a non-Anthropic upstream, or bridging
`reasoning_content` from a Chat/Responses provider into Anthropic's shape),
there's no real signature to carry forward — omitting `signature` entirely
causes some clients/SDKs to reject the block as malformed. This constant is
a placeholder that satisfies the *shape* check, **not a valid Anthropic
signature**. It's never actually forwarded to a real `messages`-speaking
upstream: every thinking block (synthetic or genuine) is converted back to
plain text by the `anthropic:thinking-signature` request hook before the
request reaches any Anthropic-native provider — see
[transforms-api.md § The Anthropic request-hook stack](./transforms-api.md#the-anthropic-request-hook-stack-anthropichooksstackts)
and
[format-conversion.md § Synthetic thinking-block signatures](./format-conversion.md#synthetic-thinking-block-signatures)
for the full reasoning.

### Messages + tools

| Type | Fields | Notes |
|---|---|---|
| `AnthropicMessage` | `role: "user" \| "assistant" \| string`, `content: string \| AnthropicBlock[]` | Unlike Chat, there is no separate system-role message — see `system` below |
| `AnthropicTool` | `name: string`, `description?: string`, `input_schema?: unknown`, `type?: string` | |
| `AnthropicToolChoice` | `{ type: "auto" \| "any" \| "none" } \| { type: "tool"; name: string } \| ({ type: string } & Record<string, unknown>)` | |
| `AnthropicThinkingConfig` | `type?: "enabled" \| "adaptive" \| "disabled" \| string`, `budget_tokens?: number`, `display?: "summarized" \| "omitted" \| string` | `AnthropicMessagesRequest.thinking` — `display` controls whether thinking content is returned as summarized text or omitted (signature only). See the `anthropic:thinking-mode` hook in transforms-api.md for per-model type normalization and display injection, and `anthropic:thinking-config` for the `budget_tokens` floor/ceiling |

### Usage

| Type | Fields |
|---|---|
| `AnthropicUsage` | `input_tokens?: number`, `output_tokens?: number`, `cache_read_input_tokens?: number`, `cache_creation_input_tokens?: number` |

### Request — `AnthropicMessagesRequest`

| Field | Type | Notes |
|---|---|---|
| `model` | `string` | |
| `messages` | `AnthropicMessage[]` | Strict `user`/`assistant` alternation enforced by `normalizeAnthropicMessages` — see format-conversion.md R6 |
| `system` | `string \| AnthropicTextBlock[]` | The **top-level** system field — Anthropic has no system-role message; see format-conversion.md R9 for how a Chat `developer`/`system` message folds into this |
| `max_tokens` | `number` | **Required** by the Anthropic API (unlike Chat's optional `max_tokens`) — a Chat request that omitted it gets a default of `4096` on conversion (format-conversion.md R7), and the engine's `anthropic:max-tokens` hook separately clamps the final value to the hop's effective ceiling |
| `temperature` / `top_p` / `top_k` | `number` | |
| `stop_sequences` | `string[]` | Anthropic's name for Chat's `stop` |
| `stream` | `boolean` | |
| `tools` | `AnthropicTool[]` | |
| `tool_choice` | `AnthropicToolChoice` | |
| `thinking` | `AnthropicThinkingConfig` | |
| `metadata` | `{ user_id?: unknown }` | |
| `output_config` | `{ effort?: unknown; format?: unknown }` | Effort control (`"low"` / `"medium"` / `"high"` / `"xhigh"` / `"max"`) and structured-output JSON schema. See [platform.claude.com/docs/en/build-with-claude/effort](https://platform.claude.com/docs/en/build-with-claude/effort). The `chatRequestToMessages` converter maps `reasoning_effort` (Chat) into `output_config.effort`, and the reverse maps `output_config.effort` back to `reasoning_effort` |
| `cache_control` | `{ type: "ephemeral"; ttl?: string } \| null` | Top-level cache control — automatically applies to the last cacheable block |
| `service_tier` | `string` | `"auto"` or `"standard_only"` — controls priority vs. standard capacity routing |

### Response (non-streaming) — `AnthropicMessagesResponse`

```ts
interface AnthropicMessagesResponse {
  id?: string;
  type?: "message";
  role?: "assistant";
  model?: string;
  content?: AnthropicBlock[];
  stop_reason?: string | null;
  stop_sequence?: string | null;
  usage?: AnthropicUsage;
}
```

### Streaming events

Discriminated by `type`. `AnthropicContentBlockDeltaEvent.delta` is itself a
nested discriminated union (`AnthropicBlockDelta`) — a stream interleaves
`content_block_start`/`_delta`/`_stop` per index as each block (text,
thinking, tool-use JSON) is assembled incrementally:

```ts
interface AnthropicMessageStartEvent {
  type: "message_start";
  message: {
    id?: string; type?: "message"; role?: "assistant"; model?: string | null;
    content?: AnthropicBlock[]; stop_reason?: string | null;
    stop_sequence?: string | null; usage?: AnthropicUsage;
  };
}
interface AnthropicContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block: AnthropicBlock;
}

// AnthropicBlockDelta — the shape of content_block_delta's `delta` field:
interface AnthropicTextDelta      { type: "text_delta";      text: string; }
interface AnthropicThinkingDelta  { type: "thinking_delta";   thinking: string; }
interface AnthropicInputJsonDelta { type: "input_json_delta"; partial_json: string; }
interface AnthropicSignatureDelta { type: "signature_delta";  signature: string; }
type AnthropicBlockDelta =
  | AnthropicTextDelta | AnthropicThinkingDelta
  | AnthropicInputJsonDelta | AnthropicSignatureDelta
  | ({ type: string } & Record<string, unknown>);

interface AnthropicContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: AnthropicBlockDelta;
}
interface AnthropicContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}
interface AnthropicMessageDeltaEvent {
  type: "message_delta";
  delta: { stop_reason?: string | null; stop_sequence?: string | null; };
  usage?: AnthropicUsage;
}
interface AnthropicMessageStopEvent { type: "message_stop"; }
interface AnthropicPingEvent { type: "ping"; }

type AnthropicStreamEvent =
  | AnthropicMessageStartEvent | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent | AnthropicMessageStopEvent
  | AnthropicPingEvent
  | ({ type: string } & Record<string, unknown>);
```

`input_json_delta`'s `partial_json` is a **fragment of a JSON string being
streamed incrementally** for a `tool_use` block's `input` — it must be
accumulated across every `content_block_delta` for that block's `index` and
parsed only once the block's `content_block_stop` arrives; a single
`partial_json` chunk is not valid JSON on its own.

### Reasoning fields (`ChatMessage.reasoning_details` / Anthropic `thinking` blocks)

Three different wire shapes carry "the model's reasoning trace" across the
formats this gateway bridges, and a transform reading/writing reasoning
content needs to know which one it's looking at:

| Format | Field(s) | Shape |
|---|---|---|
| Chat (buffered) | `ChatMessage.reasoning` / `.reasoning_content` / `.reasoning_details` | Plain string (first two) or `ChatReasoningDetail[]` (structured) |
| Chat (streaming) | `ChatDelta.reasoning` / `.reasoning_content` / `.reasoning_details` | Same three fields, incremental |
| Anthropic | `AnthropicThinkingBlock` inside `content[]` | `{ type: "thinking", thinking: string, signature: string }` |
| Responses | `ResponsesReasoningItem` (request-side) / `response.reasoning_text.*` events (streaming) | `summary: Array<{ type, text }>` / incremental `delta`+`text` |

The **concrete** shape the gateway itself writes when it extracts inline
`<thinking>`/`<reasoning>` tags from a plain-text response (see
`formats/thinking/converter.ts`) is `ReasoningDetailEntry`
(`src/formats/thinking/`, re-exported from `formats/thinking/index.ts` — a
**separate** type from `ChatReasoningDetail`, which models the wider/looser
field set an actual upstream might send):

```ts
interface ReasoningDetailEntry {
  type: "reasoning.text";
  text: string;
  format: "unknown";
  index: number;
}
```

`ChatCompletionRequest.reasoning_effort` / `ResponsesRequest.reasoning` are
typed `unknown` deliberately — the concrete values
(`"low"`/`"medium"`/`"high"`/`"xhigh"`/`"max"`, or an Anthropic/Responses-
style `{ effort }` object) vary enough across vendors that this file doesn't
attempt a shared enum; see format-conversion.md R8 for the actual
value-mapping rules between formats. On the Anthropic side, effort lives
under `output_config.effort` (not a top-level `reasoning` field — that
doesn't exist in the real API); the `anthropic:sanitize-request` hook strips
any leftover `reasoning`/`reasoning_effort` field before the body reaches
the upstream.

---

## Model-list types (`GET /v1/models`)

`src/formats/wire/models.ts` — a **separate, unrelated** pair of dialects
from the three completion formats above. `/v1/models` has only two real
shapes in the wild, and both `chat` and `responses` wire formats speak the
same one (OpenAI's):

```ts
// --- OpenAI dialect ---
interface OpenAIModel {
  id: string;
  object: "model";
  created: number;      // unix seconds
  owned_by: string;
}
interface OpenAIModelList {
  object: "list";
  data: OpenAIModel[];
}

// --- Anthropic dialect (richer) ---
interface AnthropicModel {
  id: string;
  type: "model";
  display_name: string;
  created_at: string;              // RFC 3339
  max_input_tokens?: number;       // 0/absent = unknown
  max_tokens?: number;             // 0/absent = unknown
  capabilities?: ModelCapabilities; // see Supporting types below
}
interface AnthropicModelList {
  data: AnthropicModel[];
  has_more?: boolean;   // Anthropic paginates; OpenAI does not
  first_id?: string | null;
  last_id?: string | null;
}
```

Every adapter's `fetchModels()` normalizes **either** raw dialect into one
universal, dialect-agnostic shape — callers (the Add-Provider wizard, the
Imported Models import flow) never branch on which dialect a provider spoke:

```ts
interface UpstreamModel {
  id: string;                        // the only guaranteed field
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  created?: string;                  // ISO-8601
  capabilities?: ModelCapabilities;
  raw?: Record<string, unknown>;     // the original entry, verbatim, for power users
}
```

`normalizeOpenAIModels`/`normalizeAnthropicModels`/`normalizeModels`
(`providers/base/models.ts`) do the actual mapping — a plain OpenAI provider
yields `{ id, created }` with everything else `undefined`; a rich Anthropic
provider yields the full shape. `modelsFormatOf(fmt: WireFmt): ModelsFormat`
(`providers/base/types.ts`) tells you which dialect a given `WireFmt` speaks
(`"messages"` → `"anthropic"`, everything else → `"openai"`).

---

## Supporting types

Not request/response body fields, but referenced from the tables above and
worth knowing the shape of:

### `ModelCapabilities` (`src/types/capabilities.ts`)

The Anthropic-style capability listing surfaced on `AnthropicModel.capabilities`
and `UpstreamModel.capabilities` — describes what a specific model
supports, independent of any one request:

```ts
interface CapabilitySupport { supported: boolean; }

interface ThinkingCapability {
  supported: boolean;
  types: { adaptive: CapabilitySupport; enabled: CapabilitySupport };
}
interface EffortCapability {
  supported: boolean;
  low: CapabilitySupport; medium: CapabilitySupport;
  high: CapabilitySupport; xhigh: CapabilitySupport; max: CapabilitySupport;
}
interface ContextManagementCapability {
  supported: boolean;
  clear_tool_uses_20250919: CapabilitySupport;
  clear_thinking_20251015: CapabilitySupport;
  compact_20260112: CapabilitySupport;
}
interface ModelCapabilities {
  batch: CapabilitySupport;
  citations: CapabilitySupport;
  code_execution: CapabilitySupport;
  context_management?: ContextManagementCapability;
  image_input: CapabilitySupport;
  pdf_input: CapabilitySupport;
  structured_outputs: CapabilitySupport;
  thinking: ThinkingCapability;
  effort: EffortCapability;
}
```

### `Json` / `BodyXform` (`src/formats/pipeline.ts`)

The **type-erased** shapes the pipeline actually runs on at the boundary —
every tagged transform's `apply`/`create` is internally typed against these,
with `onRequest`/`onResponse`/`onStreamEvent` doing the (safe) cast to/from
your handler's real `WireRequest<F>`/etc. type:

```ts
type Json = Record<string, unknown>;
type BodyXform = (b: Json) => Json;
```

You never author against `Json`/`BodyXform` directly in a tagged transform —
they're the plumbing underneath `onRequest`/`onResponse`/`onStreamEvent`, not
part of the authoring API. A **library** transform (`formats/transforms/registry.ts`'s
`TransformDef.build`, user-configurable per model — see
[transforms-api.md § The user-configurable transform library](./transforms-api.md#the-user-configurable-transform-library-formatstransformsregistryts))
is the one place that *does* return a plain `BodyXform` — it has no
`TransformCtx`, so it can't be format-typed the way a tagged transform can.

---

## Quick reference: every exported type by file

For a fast "which file has the type I want" lookup — every symbol
`export`ed from `src/formats/wire/`, grouped by source file.

**`openai-chat.ts`** — `ChatTextPart`, `ChatImagePart`, `ChatContentPart`,
`ChatToolCall`, `ChatReasoningDetail`, `ChatMessage`, `ChatTool`,
`ChatToolChoice`, `ChatUsage`, `ChatCompletionRequest`, `ChatChoice`,
`ChatCompletionResponse`, `ChatDelta`, `ChatChunkChoice`,
`ChatCompletionChunk`

**`openai-responses.ts`** — `ResponsesMessageItem`,
`ResponsesFunctionCallItem`, `ResponsesFunctionCallOutputItem`,
`ResponsesReasoningItem`, `ResponsesInputItem`, `ResponsesUsage`,
`ResponsesRequest`, `ResponseOutputItem`, `ResponsesResponse`,
`ResponsesStreamEventBase`, `ResponsesCreatedEvent`,
`ResponsesOutputItemEvent`, `ResponsesContentPartEvent`,
`ResponsesTextDeltaEvent`, `ResponsesReasoningTextEvent`,
`ResponsesFunctionArgsEvent`, `ResponsesStreamEvent`

**`anthropic.ts`** — `AnthropicTextBlock`, `AnthropicImageBlock`,
`AnthropicToolUseBlock`, `AnthropicToolResultBlock`,
`AnthropicThinkingBlock`, `SYNTHETIC_THINKING_SIGNATURE`,
`AnthropicDocumentBlock`, `AnthropicBlock`, `AnthropicMessage`,
`AnthropicTool`, `AnthropicToolChoice`, `AnthropicThinkingConfig`,
`AnthropicUsage`, `AnthropicMessagesRequest`, `AnthropicMessagesResponse`,
`AnthropicMessageStartEvent`, `AnthropicContentBlockStartEvent`,
`AnthropicTextDelta`, `AnthropicThinkingDelta`, `AnthropicInputJsonDelta`,
`AnthropicSignatureDelta`, `AnthropicBlockDelta`,
`AnthropicContentBlockDeltaEvent`, `AnthropicContentBlockStopEvent`,
`AnthropicMessageDeltaEvent`, `AnthropicMessageStopEvent`,
`AnthropicPingEvent`, `AnthropicStreamEvent`

**`models.ts`** — `OpenAIModel`, `OpenAIModelList`, `AnthropicModel`,
`AnthropicModelList`, `UpstreamModel`

**`index.ts`** (re-exports the four files above, plus) — `WireFmt`,
`WireRequest<F>`, `WireResponse<F>`, `WireStreamEvent<F>`

**Import everything from the barrel**, never a specific file directly:

```ts
import type {
  ChatCompletionRequest,
  AnthropicMessagesResponse,
  ResponsesStreamEvent,
  WireRequest,
} from "../../formats/wire";
```

(`formats/pipeline.ts` itself does `export * from "./wire"`, so
`import type { ChatCompletionRequest } from "../../formats/pipeline"` also
works from any transform-authoring file that's already importing
`onRequest`/`TransformCtx`/etc. from there — either import path resolves to
the same types.)
