// Anthropic accepts at most four cache_control breakpoints per request.
//
// Client-supplied breakpoints, family defaults, adapter transforms, and
// per-model transforms all compose before the Anthropic request-hook stack, so
// the final request can exceed that ceiling even when each source is valid in
// isolation. This final-boundary limiter deterministically preserves the four
// most useful stable-prefix breakpoints and removes every other occurrence.

import type { AnthropicMessagesRequest } from "../../pipeline";

type Bag = Record<string, unknown>;
type Slot = { owner: Bag; priority: number; order: number };

const MAX_CACHE_CONTROL_BLOCKS = 4;

function isBag(value: unknown): value is Bag {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function addSlot(
  slots: Slot[],
  seen: Set<Bag>,
  owner: unknown,
  priority: number,
): void {
  if (!isBag(owner) || !("cache_control" in owner) || seen.has(owner)) return;
  seen.add(owner);
  slots.push({ owner, priority, order: slots.length });
}

function collectNested(
  value: unknown,
  slots: Slot[],
  seen: Set<Bag>,
  visited: Set<object>,
): void {
  if (!value || typeof value !== "object" || visited.has(value)) return;
  visited.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) collectNested(entry, slots, seen, visited);
    return;
  }

  const bag = value as Bag;
  addSlot(slots, seen, bag, 0);
  for (const [key, entry] of Object.entries(bag)) {
    if (key !== "cache_control") collectNested(entry, slots, seen, visited);
  }
}

/**
 * Enforce Anthropic's maximum of four cache_control breakpoints.
 *
 * Priority is deterministic:
 *   1. top-level cache_control
 *   2. the last system block
 *   3. the last tool
 *   4. the last message content block
 *   5. remaining breakpoints, newest/deepest first
 *
 * The first four are exactly the stable-prefix positions used by Anthropic's
 * prompt-caching guidance and by the built-in anthropic-cache transform.
 */
export function limitAnthropicCacheControl(
  body: AnthropicMessagesRequest,
): AnthropicMessagesRequest {
  if (!body || typeof body !== "object") return body;

  const slots: Slot[] = [];
  const seen = new Set<Bag>();

  addSlot(slots, seen, body as Bag, 500);

  if (Array.isArray(body.system) && body.system.length > 0)
    addSlot(slots, seen, body.system[body.system.length - 1], 400);

  if (Array.isArray(body.tools) && body.tools.length > 0)
    addSlot(slots, seen, body.tools[body.tools.length - 1], 300);

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const last = body.messages[body.messages.length - 1];
    if (Array.isArray(last?.content) && last.content.length > 0) {
      for (let i = last.content.length - 1; i >= 0; i--) {
        const block = last.content[i];
        if (isBag(block) && "cache_control" in block) {
          addSlot(slots, seen, block, 200);
          break;
        }
      }
    }
  }

  // Catch every other cache_control occurrence, including nested tool_result
  // content and future Anthropic block shapes the wire types do not yet model.
  collectNested(body, slots, seen, new Set<object>());

  if (slots.length <= MAX_CACHE_CONTROL_BLOCKS) return body;

  const keep = new Set(
    [...slots]
      .sort((a, b) => b.priority - a.priority || b.order - a.order)
      .slice(0, MAX_CACHE_CONTROL_BLOCKS)
      .map((slot) => slot.owner),
  );

  for (const { owner } of slots) {
    if (!keep.has(owner)) delete owner.cache_control;
  }

  return body;
}
