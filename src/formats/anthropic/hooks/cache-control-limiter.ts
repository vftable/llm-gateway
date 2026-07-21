// Anthropic accepts at most four cache_control breakpoints per request.
//
// Client-supplied breakpoints, family defaults, adapter transforms, and
// per-model transforms can each add valid markers whose combined request exceeds
// that ceiling. AnthropicCompatibleAdapter invokes this at the true final body
// boundary, immediately before key ordering and serialization, so no later
// transform can reintroduce an excess breakpoint.

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
 *   1. the last system block
 *   2. the last tool definition
 *   3. the newest assistant turn's last tool_use block
 *   4. the last message content block
 *   5. explicit top-level cache_control
 *   6. remaining breakpoints, newest/deepest first
 *
 * The assistant tool_use + latest user-tail pair keeps a complete tool exchange
 * inside the growing cached prefix. Top-level auto-caching is retained when a
 * preferred manual position is absent, but yields when all four are present.
 */
export function limitAnthropicCacheControl(
  body: AnthropicMessagesRequest,
): AnthropicMessagesRequest {
  if (!body || typeof body !== "object") return body;

  const slots: Slot[] = [];
  const seen = new Set<Bag>();

  addSlot(slots, seen, body as Bag, 100);

  if (Array.isArray(body.system) && body.system.length > 0)
    addSlot(slots, seen, body.system[body.system.length - 1], 500);

  if (Array.isArray(body.tools) && body.tools.length > 0)
    addSlot(slots, seen, body.tools[body.tools.length - 1], 400);

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    // Prefer the newest assistant tool-use anchor. Together with the following
    // user/tool-result tail this keeps the complete tool exchange cached.
    outer: for (let i = body.messages.length - 1; i >= 0; i--) {
      const message = body.messages[i];
      if (message?.role !== "assistant" || !Array.isArray(message.content))
        continue;
      for (let j = message.content.length - 1; j >= 0; j--) {
        const block = message.content[j];
        if (
          isBag(block) &&
          block.type === "tool_use" &&
          "cache_control" in block
        ) {
          addSlot(slots, seen, block, 300);
          break outer;
        }
      }
    }

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
