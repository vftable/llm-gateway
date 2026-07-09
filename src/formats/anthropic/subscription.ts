// Anthropic subscription request-processing stack — NO-OP FRAMEWORK.
//
// vsllm-proxy shipped a stack that rewrote an outbound Anthropic Messages request
// to look like a first-party Claude Code call (client-attestation headers, a body
// hash, system[] reordering, tool renaming, decoy tools, thinking-block scrubbing)
// so third-party traffic would be accepted as first-party and billed against a
// Pro/Max subscription. That forges Anthropic's own client verification, so the
// gateway does NOT implement it.
//
// What lives here is the *framework* only: each stage is a real, registered
// RequestTransform with an identity (`apply: b => b`) body. The pipeline wiring,
// ordering, and extension points exist 1:1 with the original — so the seam is
// obvious and documented — but no attestation/billing logic is present. Filling
// these in is intentionally left undone.

import type { RequestTransform } from "../pipeline";

// Would rebuild system[] into Claude Code's ordering + inject the billing/
// attestation header material. NO-OP: returns the body unchanged.
export const oauthBillingStub: RequestTransform = {
  name: "anthropic-subscription:oauth-billing (no-op)",
  apply: (b) => b,
};

// Would rename third-party tool names to Claude Code's PascalCase and inject
// decoy tools. NO-OP: returns the body unchanged.
export const toolNormalizeStub: RequestTransform = {
  name: "anthropic-subscription:tool-normalize (no-op)",
  apply: (b) => b,
};

// Would strip/convert account-bound thinking blocks so they survive a key
// switch. NO-OP: returns the body unchanged.
export const thinkingStripStub: RequestTransform = {
  name: "anthropic-subscription:thinking-strip (no-op)",
  apply: (b) => b,
};

// Would erase third-party client fingerprints from system[]/messages[]. NO-OP:
// returns the body unchanged.
export const classifierScrubStub: RequestTransform = {
  name: "anthropic-subscription:classifier-scrub (no-op)",
  apply: (b) => b,
};

// The ordered stack, matching the original pipeline's sequence. Wired in by the
// AnthropicSubscriptionAdapter; every entry is currently an identity transform.
export const subscriptionRequestStack: RequestTransform[] = [
  thinkingStripStub,
  classifierScrubStub,
  toolNormalizeStub,
  oauthBillingStub,
];
