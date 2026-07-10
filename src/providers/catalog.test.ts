// Provider catalog registry + quirks unit tests. Pure functions, no DB/network.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listProviderTemplates,
  getProviderTemplate,
  isProviderTemplate,
  applyTemplateDefaults,
  capabilitiesForTemplate,
  getAdapter,
} from ".";
import { AUTH_SCHEMES, PROVIDER_FORMATS, WIRE_KINDS } from "../types";

test("catalog is non-empty and includes the requested providers", () => {
  const ids = listProviderTemplates().map((t) => t.id);
  for (const expected of [
    "openai",
    "anthropic",
    "nvidia-nim",
    "openrouter",
    "opencode",
    "xiaomi-mimo",
    "openai-compatible",
    "anthropic-compatible",
    "proxy",
  ]) {
    assert.ok(ids.includes(expected), `missing template: ${expected}`);
  }
});

test("template ids are unique", () => {
  const ids = listProviderTemplates().map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("every template has coherent defaults", () => {
  for (const t of listProviderTemplates()) {
    assert.ok(t.label && t.blurb && t.brand, `${t.id} missing metadata`);
    // format valid
    if (t.defaults.format)
      assert.ok(
        PROVIDER_FORMATS.includes(t.defaults.format),
        `${t.id} bad format`,
      );
    // auth scheme valid
    if (t.defaults.authScheme)
      assert.ok(
        AUTH_SCHEMES.includes(t.defaults.authScheme),
        `${t.id} bad authScheme`,
      );
    // endpoints are wire KINDS (chat/messages/responses).
    for (const ep of t.defaults.endpoints ?? [])
      assert.ok(
        (WIRE_KINDS as string[]).includes(ep),
        `${t.id} bad endpoint kind ${ep}`,
      );
    // at least one field, all keys valid
    assert.ok(t.fields.length > 0, `${t.id} has no fields`);
    for (const f of t.fields)
      assert.ok(
        ["name", "apiKeys", "baseUrl"].includes(f.key),
        `${t.id} bad field key ${f.key}`,
      );
  }
});

test("adapter native format matches its declared endpoint kinds", () => {
  for (const t of listProviderTemplates()) {
    const adapter = getAdapter(t.id)!;
    const kinds = t.defaults.endpoints ?? [];
    if (adapter.nativeFormat === "anthropic" && !t.defaults.nativeConversion)
      assert.ok(
        kinds.includes("messages"),
        `${t.id} anthropic without a messages kind`,
      );
    if (adapter.nativeFormat === "openai" && !t.defaults.nativeConversion)
      assert.ok(
        kinds.includes("chat") || kinds.includes("responses"),
        `${t.id} openai without a chat/responses kind`,
      );
  }
});

test("stock providers with a known origin pin a base URL", () => {
  // Generic templates intentionally omit baseUrl (user supplies it).
  const generic = new Set([
    "openai-compatible",
    "anthropic-compatible",
    "proxy",
  ]);
  for (const t of listProviderTemplates()) {
    if (generic.has(t.id)) continue;
    assert.ok(t.defaults.baseUrl, `${t.id} should pin a base URL`);
    assert.doesNotThrow(
      () => new URL(t.defaults.baseUrl as string),
      `${t.id} base URL not a valid URL`,
    );
  }
});

test("getProviderTemplate / isProviderTemplate", () => {
  assert.ok(isProviderTemplate("openai"));
  assert.ok(!isProviderTemplate("nope"));
  assert.equal(getProviderTemplate("openai")?.id, "openai");
  assert.equal(getProviderTemplate("nope"), undefined);
});

test("applyTemplateDefaults merges required headers and stamps catalogId", () => {
  const anthropic = getProviderTemplate("anthropic")!;
  const out = applyTemplateDefaults(anthropic, {
    name: "my-anthropic",
    baseUrl: undefined,
    apiKeys: ["sk-ant-x"],
  });
  assert.equal(out.catalogId, "anthropic");
  assert.equal(out.baseUrl, "https://api.anthropic.com");
  assert.equal(out.authScheme, "xapikey");
  assert.equal(out.extraHeaders?.["anthropic-version"], "2023-06-01");
  assert.deepEqual(out.apiKeys, ["sk-ant-x"]);
});

test("applyTemplateDefaults lets user values win over defaults", () => {
  const compat = getProviderTemplate("openai-compatible")!;
  const out = applyTemplateDefaults(compat, {
    name: "local",
    baseUrl: "http://localhost:1234",
    authScheme: "passthrough",
  });
  assert.equal(out.baseUrl, "http://localhost:1234");
  assert.equal(out.authScheme, "passthrough");
});

test("capabilitiesForTemplate reflects thinking quirks", () => {
  const anthropic = getProviderTemplate("anthropic")!;
  const caps = capabilitiesForTemplate(anthropic);
  assert.equal(caps.thinking.supported, true);
  assert.equal(caps.thinking.types.adaptive.supported, true);
  assert.equal(caps.thinking.types.enabled.supported, false);
  assert.equal(caps.effort.supported, true);

  // A template without thinking quirks keeps the default shape.
  const openai = getProviderTemplate("openai")!;
  const oc = capabilitiesForTemplate(openai);
  assert.ok(oc.thinking && oc.effort);
});
