// Anthropic subscription request-processing stack — NO-OP FRAMEWORK (conditional).
//
// vsllm-proxy shipped a stack that rewrote an outbound Anthropic Messages request
// to look like a first-party Claude Code call (client-attestation headers, a body
// hash, system[] reordering, tool renaming, decoy tools, thinking-block scrubbing)
// so third-party traffic would be accepted as first-party and billed against a
// Pro/Max subscription. That forges Anthropic's own client verification, so the
// gateway does NOT implement it.
//
// What lives here is the *framework* only, now wired CONDITIONALLY: each stage is
// a real, registered RequestTransform whose body only engages when
// `subscriptionActive(ctx)` is true (mirroring 9router, where these stages gate
// on the request being an OAuth/subscription flow). The gate is evaluated
// per-request; when it's false every stage is a pass-through. When it's true the
// stage body is STILL a no-op (`identity`) — the attestation/billing logic is
// intentionally left unimplemented. The pipeline wiring, ordering, gate, and
// extension points exist 1:1 with the original, so the seam is obvious and
// documented; filling in the bodies is deliberately not done.

import type { RequestTransform, TransformCtx, Json } from "../../pipeline";

// The per-request gate. Subscription processing engages only for a provider
// created from the subscription catalog template. (In the original this ALSO
// required an OAuth `sk-ant-oat` token; that per-token check belongs inside the
// unimplemented stage bodies, since the transform layer never sees raw keys.)
export function subscriptionActive(ctx: TransformCtx): boolean {
  return ctx.provider?.catalogId === "anthropic-subscription";
}

const SUBSCRIPTION_GROUP = "anthropic-subscription-hooks";

function gated(
  name: string,
  label: string,
  blurb: string,
  body: (b: Json, ctx: TransformCtx) => Json,
): RequestTransform {
  return {
    name,
    label,
    blurb,
    group: SUBSCRIPTION_GROUP,
    apply: (b, ctx) => (subscriptionActive(ctx) ? body(b, ctx) : b),
  };
}

const identity = (b: Json): Json => b;

export const classifierScrubStub = gated(
  "anthropic-subscription:classifier-scrub",
  "Client-fingerprint scrub",
  "Erase third-party client fingerprints from system[]/messages[].",
  identity,
);

export const toolNormalizeStub = gated(
  "anthropic-subscription:tool-normalize",
  "Tool-name normalization",
  "Rename third-party tool names to Claude Code's PascalCase and inject decoy tools.",
  identity,
);

export const oauthBillingStub = gated(
  "anthropic-subscription:oauth-billing",
  "OAuth billing/attestation",
  "Rebuild system[] into Claude Code's ordering and inject valid billing/attestation headers.",
  identity,
);
// The ordered stack, matching the original pipeline's sequence. Every entry is a
// gated identity transform (engages only when subscriptionActive(ctx), and even
// then does nothing).

export const subscriptionRequestStack: RequestTransform[] = [
  classifierScrubStub,
  toolNormalizeStub,
  oauthBillingStub,
];
