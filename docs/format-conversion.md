# OpenAI ⇄ Anthropic format conversion

This document is the reference for how the gateway converts between the
**OpenAI Chat Completions** wire format (`/v1/chat/completions`, internally
`chat`) and the **Anthropic Messages** wire format (`/v1/messages`, internally
`messages`). It records the non-obvious *quirks* — the small correctness rules
that a naive field-mapping misses and that cause upstream 400s or lost content
if omitted.

The converters live in [`src/formats/anthropic/bridge.ts`](../src/formats/anthropic/bridge.ts).
They run as stages in the transform pipeline (`src/formats/pipeline.ts`); the
engine selects them whenever the client's wire format differs from the serving
provider's. Conversion is symmetric and covers four bodies:

| Direction | Request | Response (buffered) | Response (streaming) |
|---|---|---|---|
| client `messages` → provider `chat` | `messagesRequestToChat` | `messagesResponseToChat`* | `MessagesToChatSseTransform`* |
| client `chat` → provider `messages` | `chatRequestToMessages` | `chatResponseToMessages`* | `ChatToMessagesSseTransform`* |

\* Response converters run **provider → client** (the reverse of the request
direction), because a response comes back in the provider's shape and must be
handed to the client in the client's shape.

> Scope note: this is a **pure wire-format conversion + API-routing** layer. It
> deliberately contains **no provider-specific behavior** — no injected system
> prompts, no `cache_control` insertion, no OAuth tool-name cloaking, no billing
> headers. Those belong to individual provider adapters, not the shared bridge.
> (9router folds several of those into its translator; we intentionally left
> them out.)

---

## Provenance

The quirks below were reverse-engineered from the
[9router](https://github.com/) `open-sse/translator` module — specifically
`request/openai-to-claude.js`, `request/claude-to-openai.js`,
`response/claude-to-openai.js`, `response/openai-to-claude.js`, and the shared
`concerns/*` (finish-reason, usage, tool-call, reasoning, image) and
`schema/*` enums. 9router pivots **every** format through OpenAI Chat as a hub
and is streaming-first (a stateful `state` object accumulates across SSE
chunks). Our bridge is a direct two-format converter but implements the same
observable rules.

---

## Request quirks

### R1 — Tool-call / tool-result id sanitization  (→ `messages`)
Anthropic requires `tool_use.id` and `tool_result.tool_use_id` to match
`^[a-zA-Z0-9_-]+$`. OpenAI ids (`call_abc:123`, etc.) can contain characters
Anthropic rejects with a 400. When converting **to** `messages` we strip every
disallowed character; if nothing survives we synthesize a deterministic id
(`call_msg{i}_tc{j}_{tool}`), which is stable across identical requests (so it
stays prompt-cache friendly).

*9router:* `concerns/toolCall.js` → `sanitizeToolId` / `generateToolCallId`,
pattern `TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/`.

### R2 — Missing tool-response insertion  (→ `chat`)
OpenAI's Chat API **requires** that every assistant `tool_calls[]` entry is
followed by a matching `role:"tool"` message; a gap is a 400. Anthropic is more
lenient. When converting Anthropic → Chat we scan for `tool_use` blocks whose id
has no following `tool_result`, and insert a placeholder
`{ role:"tool", tool_call_id, content:"[No response received]" }` in the right
position. (Anthropic → Chat only; the reverse direction does not need it.)

*9router:* `request/claude-to-openai.js` → `fixMissingToolResponsesOpenAI`.

### R3 — `response_format` → system instruction  (→ `messages`)
Anthropic has no `response_format`. When a Chat request asks for
`json_schema` or `json_object`, we translate that into an appended **system**
instruction:

- `json_schema`: *"You must respond with valid JSON that strictly follows this
  JSON schema: ```json … ``` Respond ONLY with the JSON object, no other text."*
- `json_object`: *"You must respond with valid JSON. Respond ONLY with a JSON
  object, no other text."*

*9router:* `request/openai-to-claude.js` (response_format block).

### R4 — OpenAI `file` block → Claude `document`  (→ `messages`, PDF only)
An OpenAI `{ type:"file", file:{ file_data: "data:application/pdf;base64,…" } }`
becomes a Claude `{ type:"document", source:{ type:"base64", media_type, data } }`.
**Only `application/pdf`** is emitted — Claude rejects other document mimes, so
non-PDF file blocks are dropped rather than sent and rejected.

*9router:* `request/openai-to-claude.js` → `getContentBlocksFromMessage` (FILE
branch).

### R5 — `is_error` passthrough on `tool_result`  (→ `messages`)
A Chat tool message carrying an error keeps its `is_error: true` flag when it
becomes an Anthropic `tool_result` block. (Chat has no dedicated error field on
`role:"tool"`, so this only matters when the incoming content already used the
Anthropic-shaped `tool_result` part inside a Chat message — the hybrid case.)

### R6 — Consecutive same-role merge + tool_use ordering  (→ `messages`)
Anthropic requires strict `user` / `assistant` alternation, that a `tool_result`
appears at the **start** of the user turn following the `assistant` `tool_use`
turn, and that **no text follows a `tool_use`** inside an assistant turn. The
`normalizeAnthropicMessages` pass (ported from 9router's `fixToolUseOrdering`)
enforces all three:

1. In an assistant turn containing `tool_use`, any text block appearing *after*
   the first `tool_use` is dropped (thinking blocks are kept wherever they sit).
2. Consecutive same-role turns are merged into one.
3. On merge, `tool_result` blocks are moved to the front of the combined content.

*9router:* `formats/claude.js` → `fixToolUseOrdering`.

### R9 — `developer` role folds into `system`  (→ `messages`)
OpenAI renamed the system role to `developer` in newer requests. Anthropic only
has a top-level `system` field, so both `system` and `developer` messages are
extracted (text pulled from a string or a part array) and concatenated into
`system`. No `developer`/`system` turn ever leaks into `messages[]`.

*9router:* `formats/openai.js` normalizes `developer` → `system`; we fold it into
the Anthropic `system` field directly.

### R10 — Scalar field mapping  (both directions)
Fields that exist on both APIs under different names/shapes are mapped, not
dropped:

| Chat | Anthropic Messages |
|---|---|
| `stop` (string or string[]) | `stop_sequences` (string[]) |
| `top_k` | `top_k` (passed through) |
| `user` | `metadata.user_id` |
| `metadata.user_id` | ← reverse: becomes `user` |

`top_p` and `temperature` map 1:1. Anthropic-only sampling knobs a Chat client
can't express are simply absent (not an error).

### R7 — `max_tokens` is mandatory for Anthropic  (→ `messages`)
Anthropic requires `max_tokens`. If the Chat request omits it (Chat treats it as
optional) we default to `4096`. `max_completion_tokens` is honored as a fallback
source. We do **not** apply 9router's aggressive tool-calling floor
(`DEFAULT_MIN_TOKENS = 32000`) or model-ceiling clamp — those are policy, not
format, and the per-link `maxOutputTokens` override already covers ceilings.

*9router:* `formats/maxTokens.js` → `adjustMaxTokens` (we port the "required +
default" rule only).

### R8 — Reasoning-effort passthrough  (→ `chat` and `→ messages`)
`reasoning_effort` (Chat) and `reasoning.effort` / `reasoning` (Anthropic
extended-thinking hint) are passed through when present so a downstream model
that understands them still sees them. We never *fabricate* a thinking config.

---

## Response quirks

### S1 — Thinking ⇄ reasoning_content
- **Claude → Chat:** a `thinking` content block (buffered) or `thinking_delta`
  (streaming) becomes OpenAI `message.reasoning_content` (buffered) /
  `delta.reasoning_content` (streaming). This is the vendor-neutral field GLM,
  DeepSeek, Qwen, Kimi, etc. all emit, so downstream OpenAI clients that render
  reasoning keep working.
- **Chat → Claude:** OpenAI `reasoning_content` (and the `reasoning` /
  `reasoning_details[]` variants) becomes a Claude `thinking` block / delta.

*9router:* `concerns/reasoning.js` → `extractReasoningText` (reads
`reasoning_content` | `reasoning` | `reasoning_details[]`), and the thinking
branches in both response translators.

> Note: The existing `ThinkingConverter` (`src/formats/thinking.ts`) handles the
> *textual* `<thinking>…</thinking>` tag form on provider-native bodies before
> the format stage. S1 is the complementary **structured** form (native thinking
> blocks / `reasoning_content` fields).

### S2 — Cache-token accounting
Token fields do not map 1:1:

- Anthropic usage: `input_tokens`, `output_tokens`,
  `cache_read_input_tokens`, `cache_creation_input_tokens`.
- OpenAI usage: `prompt_tokens`, `completion_tokens`, `total_tokens`,
  `prompt_tokens_details.cached_tokens`,
  `prompt_tokens_details.cache_creation_tokens`.

Rules:
- **Claude → Chat:** `prompt_tokens = input_tokens + cache_read + cache_creation`
  (Anthropic reports these separately; OpenAI folds them into `prompt_tokens`).
  `cache_read`/`cache_creation` are surfaced under `prompt_tokens_details` when
  non-zero. `total_tokens = prompt_tokens + completion_tokens`.
- **Chat → Claude:** `input_tokens = prompt_tokens − cached − cache_creation`
  (subtract the folded-in cache tokens back out), preserving the split fields.

Streaming caveat (Claude → Chat): Anthropic sends input + cache tokens in
`message_start` and only `output_tokens` in `message_delta`. The transform
captures cache from `message_start` so the final chunk's usage isn't reset to
zero by the output-only delta.

*9router:* `concerns/usage.js` → `USAGE_EXTRACTORS.claude` + `buildUsage`, and
the `message_start`/`message_delta` usage merge in
`response/claude-to-openai.js`.

### S3 — finish_reason ⇄ stop_reason
| OpenAI `finish_reason` | Anthropic `stop_reason` |
|---|---|
| `stop` | `end_turn` |
| `length` | `max_tokens` |
| `tool_calls` | `tool_use` |
| `content_filter` | `end_turn` (no Anthropic equivalent) |
| `stop` | `stop_sequence` → `stop` |

Already implemented via `FINISH_TO_STOP` / `STOP_TO_FINISH`; documented here for
completeness.

*9router:* `concerns/finishReason.js` (`toOpenAIFinish`/`fromOpenAIFinish`,
`format:"claude"`).

### S4 — Data-URI parsing tolerates newlines
Base64 image payloads are matched with `^data:([^;]+);base64,([\s\S]+)$`
(`[\s\S]`, not `.`) so a payload containing newlines still parses. Applies to
both the request image conversion and any inline data URIs.

*9router:* `concerns/image.js` → `DATA_URI_RE`.

---

## Explicitly out of scope (provider-specific, not conversion)

These 9router behaviors were reviewed and **intentionally not ported** into the
shared bridge, per the "conversion + routing only" boundary:

- Injecting a "You are Claude Code" system prompt (`CLAUDE_SYSTEM_PROMPT`).
- Adding `cache_control: { type:"ephemeral" }` breakpoints to messages/tools.
- OAuth tool-name prefixing / cloaking (`_cc` suffix, `sk-ant-oat` detection).
- Stripping `x-anthropic-billing-header:` from system text.
- Tool-argument sanitization for specific client tools (e.g. clamping the `Read`
  tool's `limit`/`offset`) — that is tool-policy, not format.
- Model-ceiling `max_tokens` clamping and the 32k tool-calling floor.

If any of these are wanted, they belong in a provider adapter's
`requestTransforms()` / `responseTransforms()`, where they compose *after* the
format stage without polluting the shared converter.

---

## Failover invariant

The forwarding engine (`src/gateway/engine.ts`) must **never let an exception
escape the fallback loop** — a throw should fall over to the next provider (or
finish with a clean 502), never surface as a 500. The guarded points:

- `buildChain` (DB reads) — wrapped; a read failure finishes 502 with a logged
  reason instead of rejecting `forward()`.
- `buildRoute` (adapter + transform-plan construction) — wrapped *inside* the
  chain loop, so a bespoke adapter/transform that throws skips to the next hop.
- Request serialization (`JSON.stringify`, which throws on a `BigInt`/circular
  body a transform produced) — inside `attemptOnce`'s guarded block, so it fails
  that attempt over instead of escaping the non-`async` function.
- `settleUsage` DB writes — wrapped; several callers run in stream-end callbacks
  where a throw would be an uncaught process-level exception.
- Router quota middleware (`getUsage`/`addUsage`) — wrapped so a transient DB
  error doesn't 500 the request via Express's default handler.

Covered by `src/gateway/engine.test.ts` (serialization throw → 502; empty chain
→ 502; both assert `forward()` resolves, never rejects). Adapter-supplied hooks
(e.g. the Anthropic subscription no-op stack) still run inside this guarded path
unchanged — they compose after the format stage and a throw in one is contained
to a single-hop failover.
