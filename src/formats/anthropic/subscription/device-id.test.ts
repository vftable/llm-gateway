import { test } from "node:test";
import assert from "node:assert/strict";
import type { TransformCtx } from "../../pipeline";
import { DEFAULT_USER_IDENTITY, parseAnthropicUserId } from "../../session-id";
import { subscriptionRequestStack } from "./index";

const normalizeDeviceId = subscriptionRequestStack.find(
  (transform) => transform.name === "claude-code:normalize-device-id",
)!;

function context(
  keyMetadata: Record<string, string> = {},
  catalogId = "claude-code",
): TransformCtx {
  return {
    provider: { catalogId } as never,
    clientFmt: "messages",
    providerFmt: "messages",
    keyMetadata,
  };
}

function body() {
  return {
    metadata: {
      user_id: JSON.stringify({
        device_id: "client-device",
        account_uuid: "client-account",
        session_id: "session-1",
      }),
    },
    messages: [],
  };
}

test("normalize device id uses account_uuid from selected key metadata", () => {
  const request = body();
  normalizeDeviceId.apply(
    request,
    context({ account_uuid: "  account-from-key  " }),
  );
  const identity = parseAnthropicUserId(request.metadata.user_id)!;
  assert.equal(identity.device_id, DEFAULT_USER_IDENTITY.device_id);
  assert.equal(identity.account_uuid, "account-from-key");
  assert.equal(identity.session_id, "session-1");
});

test("normalize device id falls back when selected key has no account_uuid", () => {
  for (const metadata of [
    {} as Record<string, string>,
    { account_uuid: "   " },
  ]) {
    const request = body();
    normalizeDeviceId.apply(request, context(metadata));
    const identity = parseAnthropicUserId(request.metadata.user_id)!;
    assert.equal(identity.account_uuid, DEFAULT_USER_IDENTITY.account_uuid);
  }
});

test("normalize device id remains a no-op outside the Claude Code provider", () => {
  const request = body();
  const before = JSON.stringify(request);
  normalizeDeviceId.apply(
    request,
    context({ account_uuid: "account-from-key" }, "anthropic"),
  );
  assert.equal(JSON.stringify(request), before);
});
