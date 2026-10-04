// Anthropic request field sanitization (request hook).
//
// Rescues effort hints from non-standard fields into output_config.effort
// (the real Anthropic field), then strips every top-level field the API does
// not accept - Chat-only fields, the gateway's own intermediates (reasoning,
// reasoning_effort), and anything a native /v1/messages client sends that
// isn't in the spec.
//
// Runs BEFORE thinking-config so the rescued effort is visible when
// thinking-config strips output_config.effort on Haiku.
//
// Allowlist verified against https://platform.claude.com/docs/en/api/messages
// (19 accepted top-level body fields as of 2026-07-13), plus `safeguards` -
// the auto-mode classifier field Claude Code sends for server-side checks
// (https://code.claude.com/docs/en/auto-mode-classifier-billing). A gateway
// that strips it makes the session fall back to client-side (billed)
// classifier requests, so it must be forwarded unchanged even though it
// isn't in the documented Messages API spec.

import type { AnthropicMessagesRequest, Json } from "../../pipeline";
import {
  isForcedToolChoiceUnsupported,
  isModelSamplingStripped,
} from "../model-version";

// Canonical key order for the outbound JSON body. JSON.stringify serializes
// in insertion order, so rebuilding the object in this sequence produces a
// deterministic, spec-aligned wire body. Keys not listed here but still in
// ALLOWED (container, inference_geo, service_tier) land at the end.
export const ORDERED_KEYS = [
  "model",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "temperature",
  "top_p",
  "top_k",
  "metadata",
  "max_tokens",
  "thinking",
  "context_management",
  "output_config",
  "cache_control",
  "stop_sequences",
  "stream",
  "container",
  "inference_geo",
  "service_tier",
  "safeguards",
] as const;

const ALLOWED = new Set<string>([...ORDERED_KEYS]);

const SAMPLING_KEYS = new Set(["temperature", "top_p", "top_k"]);

export function sanitizeAnthropicRequest(
  body: AnthropicMessagesRequest,
  model: string,
): AnthropicMessagesRequest {
  if (!body || typeof body !== "object") return body;

  rescueEffort(body);
  downgradeForcedToolChoice(body, model);

  if (typeof body.system === "string")
    body.system = [{ type: "text", text: body.system }];

  const stripSampling = isModelSamplingStripped(model);

  // Rebuild in canonical key order (strip disallowed keys in the process).
  const ordered: Json = {};
  for (const key of ORDERED_KEYS) {
    if (stripSampling && SAMPLING_KEYS.has(key)) continue;
    if (key in body) ordered[key] = body[key];
  }

  for (const key of Object.keys(body)) {
    if (!ALLOWED.has(key)) continue;
    if (stripSampling && SAMPLING_KEYS.has(key)) continue;
    if (!(key in ordered)) ordered[key] = body[key];
  }

  return ordered as AnthropicMessagesRequest;
}

// Newer models 400 on tool_choice any/tool ("type "tool" and "any" are not
// supported for this model"). Degrade to auto, keeping disable_parallel_tool_use.
function downgradeForcedToolChoice(
  body: AnthropicMessagesRequest,
  model: string,
): void {
  const tc = body.tool_choice as
    | { type?: string; disable_parallel_tool_use?: boolean }
    | undefined;
  if (!tc || typeof tc !== "object") return;
  if (tc.type !== "any" && tc.type !== "tool") return;
  if (!isForcedToolChoiceUnsupported(model)) return;
  const next: Record<string, unknown> = { type: "auto" };
  if (tc.disable_parallel_tool_use !== undefined)
    next.disable_parallel_tool_use = tc.disable_parallel_tool_use;
  body.tool_choice = next as typeof body.tool_choice;
}

const ANTHROPIC_EFFORTS =["low", "medium", "high", "xhigh", "max"] as const;
type AnthropicEffort = (typeof ANTHROPIC_EFFORTS)[number];

export function toAnthropicEffort(value: unknown): AnthropicEffort | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.toLowerCase();
  if (ANTHROPIC_EFFORTS.includes(v as AnthropicEffort))
    return v as AnthropicEffort;
  if (v === "x-high" || v === "extra-high" || v === "extra_high")
    return "xhigh";
  if (v === "maximum" || v === "highest") return "max";
  if (v === "lowest" || v === "minimal" || v === "min") return "low";
  return undefined;
}

function rescueEffort(body: AnthropicMessagesRequest): void {
  const oc = body.output_config;
  if (oc && typeof oc === "object" && oc.effort !== undefined) {
    const casted = toAnthropicEffort(oc.effort);
    if (casted) oc.effort = casted;
    return;
  }

  const reasoning = body.reasoning as { effort?: unknown } | undefined;
  const effort =
    (reasoning && typeof reasoning === "object"
      ? reasoning.effort
      : undefined) ?? body.reasoning_effort;

  if (effort === undefined) return;

  const casted = toAnthropicEffort(effort) ?? effort;

  if (oc && typeof oc === "object") {
    oc.effort = casted;
  } else {
    body.output_config = { effort: casted };
  }
}
