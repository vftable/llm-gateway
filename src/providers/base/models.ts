// Model-list discovery + normalization: fetchModelList (the raw dialect-tagged
// GET primitive) and the OpenAI/Anthropic -> universal UpstreamModel[]
// normalizers.

import { WireKind } from "../../types";
import type {
  OpenAIModelList,
  AnthropicModelList,
  UpstreamModel,
} from "../../formats/wire/models";
import type { WireRequest } from "../../formats/wire";
import {
  DEFAULT_ANTHROPIC_VERSION,
  type WireFmt,
  type FetchModelListOptions,
  type ModelListTransport,
  type ModelsResult,
} from "./types";

// The smallest real request body that gets a one-token reply out of each wire
// kind — what `probeEndpoint()` sends by default, TYPED to that kind's own
// request schema so an override never hand-writes an untyped object. Pass your
// own body to `probeEndpoint()` instead when a provider needs something
// different (e.g. rejects `max_tokens` on some models).
export function minimalProbeBody<K extends WireFmt>(
  kind: K,
  model: string,
): WireRequest<K> {
  const probe = "Reply with a single word.";
  if (kind === WireKind.Messages) {
    return {
      model,
      max_tokens: 8,
      messages: [{ role: "user", content: probe }],
    } as WireRequest<K>;
  }
  if (kind === WireKind.Responses) {
    return { model, max_output_tokens: 8, input: probe } as WireRequest<K>;
  }
  return {
    model,
    max_tokens: 8,
    messages: [{ role: "user", content: probe }],
  } as WireRequest<K>;
}

// Default transport: global fetch, GET, headers passed straight through.
const globalFetchTransport: ModelListTransport = async (url, init) => {
  const res = await fetch(url, {
    method: "GET",
    headers: init.headers,
    ...(init.signal ? { signal: init.signal } : {}),
  });
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    json: () => res.json(),
  };
};

// --- normalization: raw dialect list → universal UpstreamModel[] -------------

// A positive finite number, else undefined (upstreams send 0 for "unknown").
function posNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

// A non-empty trimmed string, else undefined.
function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

// OpenAI dialect → universal. OpenAI only exposes id + a unix `created` (seconds);
// everything richer is left undefined.
export function normalizeOpenAIModels(list: OpenAIModelList): UpstreamModel[] {
  const out: UpstreamModel[] = [];
  const data = Array.isArray(list?.data) ? list.data : [];
  for (const m of data) {
    if (!m || typeof m.id !== "string" || !m.id) continue;
    const created =
      typeof m.created === "number" && Number.isFinite(m.created)
        ? new Date(m.created * 1000).toISOString()
        : undefined;
    out.push({ id: m.id, created, raw: m });
  }
  return out;
}

// Anthropic dialect → universal. Anthropic is the rich source: display_name,
// max_input_tokens (→ contextWindow), max_tokens (→ maxOutputTokens), an ISO
// created_at, and the full capability listing. Blank/zero fields drop to undefined.
export function normalizeAnthropicModels(
  list: AnthropicModelList,
): UpstreamModel[] {
  const out: UpstreamModel[] = [];
  const data = Array.isArray(list?.data) ? list.data : [];
  for (const m of data) {
    if (!m || typeof m.id !== "string" || !m.id) continue;
    out.push({
      id: m.id,
      displayName: nonEmpty(m.display_name),
      contextWindow: posNum(m.max_input_tokens),
      maxOutputTokens: posNum(m.max_tokens),
      created: nonEmpty(m.created_at),
      capabilities: m.capabilities,
      raw: m,
    });
  }
  return out;
}

// Normalize a raw fetchModelList() result into the universal list, regardless of
// which dialect it was parsed as.
export function normalizeModels(result: ModelsResult): UpstreamModel[] {
  return result.format === "anthropic"
    ? normalizeAnthropicModels(result.list)
    : normalizeOpenAIModels(result.list);
}

// QoL: reduce a universal list to its sorted, de-duped ids — the shape the
// import wizard's id-only picker and the connectivity summary want.
export function modelIds(models: UpstreamModel[]): string[] {
  const ids = new Set<string>();
  for (const m of models) {
    if (m && typeof m.id === "string" && m.id) ids.add(m.id);
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

// Case-insensitive "is this header already set?" (header names are case-insensitive
// per HTTP; a caller might pass "Anthropic-Version").
function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

// The maximally-flexible model-list primitive: GET any `url` with any `headers`
// in the requested `format`, returning the tagged, parsed list. Sets `accept`
// and (for Anthropic) `anthropic-version` automatically, without clobbering
// caller-supplied values. Throws on a non-2xx response or non-JSON body. This is
// the shared core the adapter's fetchModels() default delegates to; the route
// and tests can call it directly.
export async function fetchModelList(
  opts: FetchModelListOptions,
): Promise<ModelsResult> {
  const format = opts.format ?? "openai";
  const headers: Record<string, string> = {
    accept: "application/json",
    ...opts.headers,
  };
  if (format === "anthropic" && !hasHeader(headers, "anthropic-version")) {
    headers["anthropic-version"] =
      opts.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;
  }
  const transport = opts.transport ?? globalFetchTransport;
  const res = await transport(opts.url, {
    headers,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) {
    throw new Error(`model list failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as unknown;
  return format === "anthropic"
    ? { format: "anthropic", list: body as AnthropicModelList }
    : { format: "openai", list: body as OpenAIModelList };
}
