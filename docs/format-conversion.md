# OpenAI ⇄ Anthropic format conversion

This document is the reference for how the gateway converts between the
**OpenAI Chat Completions** wire format (`/v1/chat/completions`, internally
`chat`) and the **Anthropic Messages** wire format (`/v1/messages`, internally
`messages`). It records the non-obvious *quirks* — the small correctness rules
that a naive field-mapping misses and that cause upstream 400s or lost content
if omitted. See [`docs/provider-adapters.md`](./provider-adapters.md) for how
a provider adapter routes/builds requests around this conversion,
[`docs/transforms-api.md`](./transforms-api.md) for how the tagged transform
stages referenced throughout this file (the Anthropic request hooks, thinking
extraction, the default provider transform stack, the opt-in library) are
authored and placed in the pipeline, and
[`docs/wire-types.md`](./wire-types.md) for the field-by-field type reference
of the request/response shapes these quirks operate on (`ChatMessage`,
`AnthropicBlock`, etc.) — this file covers the *behavior*, wire-types.md
covers *what fields exist*.

The converters live in
[`src/formats/converters/chat-messages/`](../src/formats/converters/chat-messages)
(pure cross-format converters — `formats/converters/` holds format translation
for every wire-format pair the gateway bridges; `formats/anthropic/` holds
Anthropic-native hooks, i.e. behavior that applies to a Messages-shaped body
regardless of which client format produced it). The sibling pair,
[`formats/converters/chat-responses/`](../src/formats/converters/chat-responses),
bridges OpenAI Chat Completions and the Responses API — see its own module doc
comment for that pair's coverage; a `responses<->messages` hop composes both
pairs through Chat as a pivot (`src/formats/pipeline.ts`) rather than a bespoke
third converter. They run as stages in the transform pipeline
(`src/formats/pipeline.ts`); the engine selects them whenever the client's wire
format differs from the serving provider's. Conversion is symmetric and covers
four bodies:

| Direction | Request | Response (buffered) | Response (streaming) |
|---|---|---|---|
| client `messages` → provider `chat` | `messagesRequestToChat` | `messagesResponseToChat`* | `MessagesToChatSseTransform`* |
| client `chat` → provider `messages` | `chatRequestToMessages` | `chatResponseToMessages`* | `ChatToMessagesSseTransform`* |

\* Response converters run **provider → client** (the reverse of the request
direction), because a response comes back in the provider's shape and must be
handed to the client in the client's shape.

> Scope note: this file is a **pure wire-format converter**. Provider-specific
> behavior lives elsewhere and composes *after* conversion (see **Anthropic
> request hooks** below): the Anthropic-native normalizations run as provider
> adapter request transforms. Prompt caching and tool-arg sanitization are
> library transforms **defaulted on for every Anthropic-native provider
> family** (`ANTHROPIC_DEFAULT_TRANSFORMS`, applied automatically — see
> [transforms-api.md § The default provider transform
> stack](./transforms-api.md#the-default-provider-transform-stack)); system
> injection remains fully opt-in, picked per model in the UI. The OAuth
> first-party *impersonation* stack is intentionally **not** implemented (see
> the boundary note at the end).

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

### R8 — Reasoning-effort mapping  (→ `chat` and `→ messages`)
`reasoning_effort` (Chat) maps to `output_config.effort` (Anthropic Messages)
and vice versa. The Anthropic API has no `reasoning` or `reasoning_effort`
field — effort lives under the top-level `output_config` object (see
[platform.claude.com/docs/en/build-with-claude/effort](https://platform.claude.com/docs/en/build-with-claude/effort)).

The two APIs use different effort scales:

| OpenAI (Chat / Responses) | Anthropic Messages |
|---|---|
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| *(no equivalent)* | `xhigh` |
| *(no equivalent)* | `max` |

- **Chat → Messages:** `reasoning_effort` → `output_config: { effort }`,
  cast to Anthropic's 5-level scale via `toAnthropicEffort()`. The three
  shared values (`low`/`medium`/`high`) pass through; aliases like `x-high`,
  `maximum`, `minimal` are normalized.
- **Messages → Chat:** `output_config.effort` → `reasoning_effort`, mapped
  to OpenAI's 3-level scale via `toOpenAIEffort()`. Anthropic's `xhigh` and
  `max` both map to `high` (the closest Chat equivalent). Falls back to the
  legacy `reasoning.effort` / `reasoning_effort` fields for backwards
  compatibility with older gateway bodies, but only the `output_config` form
  is correct for the real Anthropic API.
- The `anthropic:sanitize-request` hook also casts effort to valid Anthropic
  values on native `/v1/messages` requests (not just cross-format conversions).

#### Z.AI GLM reasoning effort

The Z.AI GLM Coding adapter uses the same Chat-shaped hook, but applies Z.AI's
native rules at the final provider-boundary stage:

- GLM-5.2 and later accept `low`, `medium`, `high`, `xhigh`, and `max` without
  GPT-family clamping, and the gateway ensures `thinking.type` is `enabled`.
- `minimal` and `none` disable thinking and are removed from the outbound
  `reasoning_effort` field. Compatibility aliases (`maximum`, `x-high`, `min`,
  `lowest`, etc.) are normalized first.
- An explicit native `thinking.type: "disabled"` wins over a positive effort.
- Earlier GLM versions receive only the `thinking.type` enable/disable toggle;
  unsupported `reasoning_effort` is not forwarded.
- The behavior is gated by the Z.AI provider catalog identity, so a GLM-named
  model behind OpenRouter or another compatible provider retains that
  provider's generic OpenAI reasoning behavior.

Official reference: [Z.AI reasoning_effort](https://docs.z.ai/guides/overview/concept-param#reasoning_effort).

For generic OpenAI-compatible providers we never *fabricate* a thinking config
from an effort hint; the GLM branch above is the provider-specific exception
required by Z.AI's documented wire contract.

### R11 — `reasoning.summary` passthrough  (→ `chat` and `→ messages`)
The Responses API's `reasoning.summary` (`"auto"` | `"concise"` | `"detailed"`)
controls whether the model includes reasoning summaries in the response. Chat
Completions has no equivalent field, so the gateway carries it as a gateway-
internal `_reasoning_summary` field through the Chat pivot.

- **Responses → Chat:** `reasoning.summary` → `_reasoning_summary` (opaque
  passthrough — Chat clients don't see it, but it survives a round-trip
  through Chat to a Responses-native provider).
- **Chat → Responses:** `_reasoning_summary` → `reasoning.summary`.
- **Chat → Messages:** `_reasoning_summary` → `thinking.display: "summarized"`
  (any summary mode maps to Anthropic's summarized thinking display).
- **Messages → Chat:** `thinking.display: "summarized"` → `_reasoning_summary: "auto"`.

### R12 — `encrypted_content` on reasoning items  (round-trip)
Reasoning output items carry an opaque `encrypted_content` blob for multi-turn
continuity. The gateway preserves this through the Chat pivot as a
`_encrypted_content` field on each `reasoning_details` entry, and restores it
when converting back to Responses output items. Each reasoning item is preserved
as a separate output item (not collapsed into one).

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

> Note: `ThinkingConverter` (`src/formats/thinking/converter.ts`) handles the
> *textual* `<thinking>…</thinking>` tag form on provider-native bodies before
> the format stage. S1 is the complementary **structured** form (native thinking
> blocks / `reasoning_content` fields).

#### Synthetic thinking-block signatures

A real Anthropic `thinking` block always carries a cryptographic `signature` —
Anthropic verifies it if a client echoes the block back on a later turn (e.g. a
tool-use continuation) and 400s if it's missing or invalid. Every place the
gateway itself **builds** a `thinking` block — the Chat→Claude response/stream
conversion above, and `ThinkingConverter` splitting an inline `<thinking>` tag
out of a provider-native text block — has no real signature to attach, because
the text never came from an actual Anthropic extended-thinking turn. Omitting
`signature` entirely causes some clients/SDKs (including Anthropic's own) to
reject the block on echo-back, so every block the gateway synthesizes carries
[`SYNTHETIC_THINKING_SIGNATURE`](../src/formats/wire/anthropic.ts)
(`"llmapi-synthetic-thinking"`) instead — buffered as the block's `signature`
field, streaming as a `signature_delta` event emitted immediately before the
block's `content_block_stop`. This matches the confirmed live-API event
sequence for a thinking block:
`content_block_start {thinking:"",signature:""}` → one or more
`thinking_delta` → **one `signature_delta`** → `content_block_stop` (verified
against [platform.claude.com/docs/.../extended-thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
and [.../streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)
— the docs also confirm a *real* thinking block always carries `signature`,
even when `display:"omitted"` leaves `thinking` itself empty, and that
Anthropic 400s with `invalid_request_error` ("`thinking` or
`redacted_thinking` blocks in the latest assistant message cannot be
modified") if a client rearranges, drops, or alters one on echo-back — which
is exactly the failure this synthesis avoids). The synthetic value is **not**
a valid Anthropic signature; it exists purely so the block's *shape* matches
a real one. See **Anthropic request hooks** below for why this placeholder is
never actually round-tripped anywhere that would need it to be genuine —
every outbound request strips it right back out.

A `thinking`/`reasoning` block that is empty or whitespace-only after
extraction (`<thinking></thinking>`, or a chunk that opens and immediately
closes the tag) is **dropped**, never emitted as an empty block — real
providers never send one, and an empty block on the wire serves no purpose
other than confusing a client that renders it.

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

## Anthropic request hooks (run on every path)

The Anthropic-native request normalizations are **not** in the converter, and
**not** per-adapter `requestTransforms()` either — they're an ALL-PROVIDER
request default (`src/formats/anthropic/hooks/`, registered in
`formats/transforms/defaults.ts`'s `DEFAULT_TRANSFORMS`), format-tagged
`"messages"` and internally gated on `ctx.providerFmt === "messages"`. The
engine adds them to every route; `buildTransformPlan` places a
`"messages"`-tagged request stage exactly where the body is in Messages
shape (post-conversion for a hop that converts *into* Messages, pre-conversion
— i.e. a no-op, since the gate fails — for a hop that doesn't), so these fire
identically for:

- native `/v1/messages` (messages → messages, no convert),
- converted `/v1/chat/completions` (chat → messages) or a `responses` client
  routed through the chat↔messages pivot,
- the Firecrawl web-tool loop (`runOneTurnAttempt` builds the same route).

The stack (`hooks/stack.ts`), in order:

| Hook | File | What it does |
|---|---|---|
| `anthropic:thinking-signature` | `hooks/thinking-signature.ts` | convert every `thinking` content block — synthetic or genuine — to a signature-free `text` block carrying the same reasoning prose; always drop `redacted_thinking` blocks. See **Synthetic thinking-block signatures** above for why even a genuine signature can't be trusted here. |
| `anthropic:max-tokens` | `hooks/max-tokens.ts` | clamp `max_tokens` to the hop's effective ceiling (`TransformCtx.maxOutputTokens` = link ?? imported ?? model), re-shrinking `budget_tokens` if the clamp would breach `budget < max` |
| `anthropic:prefill` | `hooks/prefill.ts` | Claude 4.6+ prefill fix — append a trailing `user` turn when the convo ends `assistant` (with `tool_result` blocks when the last turn had `tool_use`) |
| `anthropic:sanitize-request` | `hooks/sanitize-request.ts` | Rescue effort from non-standard fields (`reasoning.effort`, `reasoning_effort`) into `output_config.effort`, cast to valid Anthropic effort levels via `toAnthropicEffort()`, then strip every top-level field not in the Anthropic Messages API allowlist (18 fields — see hook source). Catches Chat-only fields (`presence_penalty`, `frequency_penalty`, `logprobs`, `seed`, `parallel_tool_calls`, …), the gateway's own intermediate fields, and anything else a client or converter leaves on the body that would cause an upstream 400 |
| `anthropic:thinking-mode` | `hooks/thinking-mode.ts` | Per-model thinking type normalization: `enabled`→`adaptive` for Opus 4.7+/Sonnet 5+ (which reject `enabled`), `adaptive`→`enabled` with 10k budget for Haiku/≤4.5, forced `adaptive` for Fable/Mythos. Injects `display:"summarized"` on models that default to `"omitted"` (Fable 5, Mythos 5, Sonnet 5, Opus 4.7/4.8, Mythos Preview) unless the client set `display` explicitly |
| `anthropic:thinking-config` | `hooks/thinking-config.ts` | Floor `budget_tokens` to 1024 and keep it `< max_tokens` (raise `max_tokens` to `budget+1024`); hoist mid-conversation `role:"system"` turns into top-level `system`; strip `output_config.effort` on Haiku. Runs **last** so it gets the final say on `max_tokens` |

`thinking-signature` runs first so every hook after it sees a body with no
`thinking`-typed content blocks at all — a deliberate structural
normalization before anything else inspects the message shape.
`sanitize-request` runs before `thinking-mode` so the rescued effort is
visible. `thinking-mode` normalizes the thinking type per model before
`thinking-config` reconciles budget vs max_tokens. `thinking-config` runs
last so it gets the final say on `max_tokens` (it may raise it above the
ceiling max-tokens imposed). These moved
off the router middleware (which ran pre-conversion on the client body, keyed
on the alias, and missed the web-tool loop). Verified against the live
Anthropic Messages docs. Covered by
`src/formats/anthropic/hooks/hooks.test.ts`,
`src/formats/anthropic/hooks/thinking-signature.test.ts`,
`src/formats/anthropic/hooks/sanitize-request.test.ts`, and
`src/providers/anthropic-hooks.test.ts`.

## Library transforms — defaulted vs. opt-in

Provider-feature behaviors beyond the request hooks above are offered as
transforms in the library (`src/formats/transforms/`, catalog via
`GET /api/transforms`) — but they're **not all opt-in**. Two apply
automatically to every Anthropic-native provider (the **default provider
transform stack** — see
[transforms-api.md](./transforms-api.md#the-default-provider-transform-stack)
for the full mechanics); one remains fully opt-in, configured per imported
model in the UI:

| Transform | Phase | Default for Anthropic-native providers? | What it does |
|---|---|---|---|
| `anthropic-cache` | request | **Yes** — `ANTHROPIC_DEFAULT_TRANSFORMS`, `ttl:"5m"` | Add `cache_control:{type:"ephemeral", ttl}` breakpoints to the stable prefix (last `system` block, last tool, last message content block) for Anthropic prompt caching. `ttl` = `5m`\|`1h`. Skips thinking blocks and no-ops on an OpenAI-shaped body. The final `anthropic:cache-control-limit` request hook counts client-, family-, adapter-, and model-supplied breakpoints together and deterministically removes excess entries so the outbound request never exceeds Anthropic's maximum of four. |
| `sanitize-tool-args` | response | **Yes** — `ANTHROPIC_DEFAULT_TRANSFORMS` | Coerce/clamp malformed tool-call args from non-Claude models (numeric strings→numbers, `Read.limit` ≤ 2000, drop negative offsets / invalid pdf `pages`) in both the Anthropic `tool_use.input` and chat `tool_calls[].arguments` shapes. |
| `system-prepend` | request | No — opt-in only | Prepend a **user-supplied** system string (Anthropic `system` or chat system message). Generic — the text is yours. |

A model can still override the family's `anthropic-cache`/`sanitize-tool-args`
default (e.g. to change the TTL, or disable by pointing the same `id+phase`
at different params) by adding an entry with the matching `id`/`phase` in
its own transform config — the model's entry wins by `(id, phase)` (see
`mergeTransforms` in transforms-api.md). Use
`GET /providers/:id/transforms/resolved` (or the "Default transforms" panel
in the admin UI) to see exactly what applies to a given provider/model —
never guess from this table alone, since it only says what's true for the
*catalog default*, not any provider-specific override.

## Anthropic streaming pings

Every client-facing `/v1/messages` SSE response emits Anthropic's protocol
ping frame exactly as documented by the Messages API:

```sse
event: ping
data: {"type":"ping"}

```

The gateway emits one immediately after the upstream request is accepted and
the client response is opened, then emits another every **15 seconds** until
the stream ends. This is a fixed protocol guarantee for Messages streams: it
continues while content is flowing and is not disabled or changed by the
generic SSE keepalive setting. The same rule applies while the buffered
web-tool loop is processing searches and upstream turns. OpenAI-compatible
SSE streams retain the configurable idle comment keepalive.

The normal Messages event lifecycle remains unchanged:
`message_start` → content block events → `message_delta` → `message_stop`, with
ping events permitted between any of those events.

## Hosted / custom tools

- **Native `messages → messages`:** hosted Anthropic tools
  (`web_search_20250305`, `computer_*`, `bash_*`, `text_editor_*`) pass through
  untouched — the request hooks never mangle them (asserted in the hook tests).
- **Firecrawl web-tool loop:** runs *before* the request hooks (unchanged); the
  gateway drives the search/fetch loop itself for Messages clients.
- **`chat → messages`:** the converter drops non-portable hosted tools
  (`anthropicToolsToChat` skips `computer_*`/`web_search`) since Chat can't
  express them — documented, unchanged.

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
