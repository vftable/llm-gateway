// Thinking extraction as an all-provider default, expressed as tagged transforms.
//
// Every provider gets these for free: they pull inline <thinking>/<reasoning>
// blocks out of an upstream response and surface them as the wire format's native
// reasoning shape (chat reasoning_details, Anthropic thinking blocks, Responses
// reasoning items). Historically the engine applied this OUTSIDE the transform
// arrays — `applyThinking(providerFmt, body)` on the buffered body and
// `thinkingStream(providerFmt)` as the first stream stage — both BEFORE the
// format bridge, on the provider-native shape.
//
// Here that becomes a **pre-bridge, provider-format-tagged** response/stream
// transform (see pipeline buildTransformPlan): a stage tagged the PROVIDER format
// runs before the bridge, reading provider-native fields exactly as before. The
// engine prepends these to every route's response/stream `extra`, so the order is
// byte-identical to the old standalone calls (thinking first, then the bridge).

import type {
  TaggedResponseTransform,
  TaggedStreamTransform,
  Json,
  WireFmt,
} from "../pipeline";
import { ThinkingConverter } from "./converter";
import { SseThinkingTransform } from "./chat-stream";
import { AnthropicThinkingTransform } from "./messages-stream";

// Shared display metadata for the buffered + streaming thinking stages below
// — same behavior regardless of which wire format they're tagged for, so one
// label/blurb covers all of them (see TransformMeta's doc comment in
// formats/pipeline.ts). Not grouped: each is tagged a DIFFERENT format and
// only ever one of them fires on a given hop (see this file's own header
// comment), so there's never more than one visible at once to collapse.
const THINKING_LABEL = "Inline <thinking> tag extraction";
const THINKING_BLURB =
  "Pulls inline <thinking>/<reasoning> text out of the response and surfaces it as the wire format's native reasoning shape — only scans actual message content, never tool-call arguments or results.";

// The buffered-response thinking layer: one tagged transform per format. Only the
// one whose tag matches the hop's providerFmt runs (pre-bridge). Guarded so a
// malformed body can never throw into the response path.
export function defaultThinkingResponse(
  conv: ThinkingConverter,
): TaggedResponseTransform[] {
  const run = (
    fmt: WireFmt,
    apply: (b: Json) => Json | null,
  ): TaggedResponseTransform => ({
    name: `thinking:${fmt}`,
    phase: "response",
    format: fmt,
    label: THINKING_LABEL,
    blurb: THINKING_BLURB,
    apply: (body) => {
      try {
        return apply(body) ?? body;
      } catch {
        return body;
      }
    },
  });
  return [
    run("chat", (b) => conv.applyToChatCompletion(b as never) as Json | null),
    run(
      "messages",
      (b) => conv.applyToAnthropicMessage(b as never) as Json | null,
    ),
    run("responses", (b) => conv.applyToResponse(b as never) as Json | null),
  ];
}

// The streaming thinking layer: chat + messages have an SSE thinking transform;
// Responses has none (as before). Tagged the provider format so it runs
// pre-bridge on the provider-native SSE.
export function defaultThinkingStream(): TaggedStreamTransform[] {
  return [
    {
      name: "thinking:chat",
      phase: "response",
      format: "chat",
      label: THINKING_LABEL,
      blurb: THINKING_BLURB,
      create: () => new SseThinkingTransform(),
    },
    {
      name: "thinking:messages",
      phase: "response",
      format: "messages",
      label: THINKING_LABEL,
      blurb: THINKING_BLURB,
      create: () => new AnthropicThinkingTransform(),
    },
  ];
}
