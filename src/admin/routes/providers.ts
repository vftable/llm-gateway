// Provider CRUD, connectivity test, provider-catalog (wizard), and imported
// provider-model routes.

import {
  createProvider,
  deleteProvider,
  getProvider,
  listProviders,
  updateProvider,
  normBasePath,
} from "../../repo/providers";
import {
  listProviderModels,
  upsertProviderModel,
  updateProviderModel,
  deleteProviderModel,
  getProviderModel,
  getProviderModelById,
  countProviderModelsByProvider,
} from "../../repo/provider-models";
import { listProviderTemplates, type UpstreamModel } from "../../providers";
import type { AuthScheme } from "../../types";
import type { RouteCtx, ProviderLike } from "./types";
import {
  str,
  num,
  parseProviderInput,
  parseCapabilities,
  parseTransformConfig,
} from "./parsers";
import {
  testProviderAdhoc,
  testSavedProvider,
  testProviderModel,
  fetchProviderModels,
  fetchUpstreamModels,
} from "./provider-probe";
import { resolveProviderTransforms } from "./resolved-transforms";
import { buildUsageReport, buildUsageReports } from "./usage-report";
import { bad } from "./respond";

export function registerProviderRoutes(ctx: RouteCtx): void {
  const { db, logger, router, r, requireAdmin, broadcast } = ctx;

  // --- providers ---
  // Attach importedModelCount (rows in provider_models) so the card badge shows
  // the true registered-imported count, not the exposed-chain hop count.
  r.get("/providers", requireAdmin, (_req, res) => {
    const counts = countProviderModelsByProvider(db);
    res.json(
      listProviders(db).map((p) => ({
        ...p,
        importedModelCount: counts[p.id] ?? 0,
      })),
    );
  });

  // Standardized upstream key-usage report per provider (5h + weekly windows).
  // Adapters supply the windows (real when they can query the upstream, dummy
  // otherwise). Registered before "/providers/:id" so "usage" isn't parsed as an
  // id. Keys are masked here; the raw secret never leaves the backend.
  r.get("/providers/usage", requireAdmin, async (_req, res) => {
    res.json(await buildUsageReports(db));
  });

  r.post("/providers", requireAdmin, (req, res) => {
    try {
      const input = parseProviderInput(req.body, true);
      const p = createProvider(db, input);
      router.reload();
      broadcast(["providers", "overview"], "provider:create");
      res.status(201).json(p);
    } catch (e) {
      bad(res, e);
    }
  });

  r.get("/providers/:id", requireAdmin, (req, res) => {
    const p = getProvider(db, String(req.params.id));
    if (!p) return res.status(404).json({ error: { message: "not found" } });
    res.json(p);
  });

  r.put("/providers/:id", requireAdmin, (req, res) => {
    try {
      const id = String(req.params.id);
      const p = updateProvider(db, id, parseProviderInput(req.body));
      if (!p) return res.status(404).json({ error: { message: "not found" } });
      router.reload();
      broadcast(["providers", "overview"], "provider:update");
      res.json(p);
    } catch (e) {
      bad(res, e);
    }
  });

  r.delete("/providers/:id", requireAdmin, (req, res) => {
    if (!deleteProvider(db, String(req.params.id)))
      return res.status(404).json({ error: { message: "not found" } });
    router.reload();
    broadcast(["providers", "models", "overview"], "provider:delete");
    res.status(204).end();
  });

  // Live test: goes through the resolved adapter's testProvider() seam (default:
  // GET {baseUrl}{basePath}{modelsPath} with the key's auth — see
  // ProviderAdapter.testProvider; a bespoke provider can override this, see
  // example-custom.ts). With no body, uses the SAME live rotation/health state
  // a real chat request would (pickKeyForTest) — including a full round-robin
  // advance — so the reported key isn't a fake stand-in; back-to-back test
  // clicks cycle the pool exactly like traffic would. No model context (a
  // provider-level test isn't scoped to one). An explicit `key` in the body
  // (the per-key Test button in the Keys tab) bypasses pickKeyForTest entirely
  // and sends exactly that key — it must be one of the provider's own
  // configured keys (enabled or disabled), never an arbitrary caller-supplied
  // string.
  r.post("/providers/:id/test", requireAdmin, async (req, res) => {
    const provider = getProvider(db, String(req.params.id));
    if (!provider)
      return res.status(404).json({ error: { message: "not found" } });
    const requestedKey = str((req.body as Record<string, unknown>)?.key);
    if (
      requestedKey &&
      !provider.apiKeys.includes(requestedKey) &&
      !(provider.disabledApiKeys ?? []).includes(requestedKey)
    )
      return res
        .status(400)
        .json({ error: { message: "key is not configured on this provider" } });
    try {
      const key =
        requestedKey ?? router.pickKeyForTest(provider, null)?.key ?? undefined;
      const result = await testSavedProvider(provider, key);
      res.json(result);
    } catch (e) {
      res.json({ ok: false, status: null, ms: 0, error: (e as Error).message });
    }
  });

  // Per-provider usage report — the same adapter async keyUsage() query as the
  // dashboard, scoped to one provider (the Keys tab awaits this).
  r.get("/providers/:id/usage", requireAdmin, async (req, res) => {
    const provider = getProvider(db, String(req.params.id));
    if (!provider)
      return res.status(404).json({ error: { message: "not found" } });
    res.json(await buildUsageReport(provider));
  });

  // Probe upstream models via the adapter's fetchModels() seam (honors any
  // provider-specific override), returning sorted, de-duped model IDs.
  r.get("/providers/:id/upstream-models", requireAdmin, async (req, res) => {
    const provider = getProvider(db, String(req.params.id));
    if (!provider)
      return res.status(404).json({ error: { message: "not found" } });
    try {
      const models = await fetchProviderModels(provider);
      res.json({ models });
    } catch (e) {
      res.json({ models: [], error: (e as Error).message });
    }
  });

  // The FULL resolved default transform stack for this provider — see
  // resolved-transforms.ts's header comment for exactly what's composed and
  // in what order. Read-only: this is a preview of what the engine already
  // does, not a config surface (nothing here is ever written back). Optional
  // ?upstreamId=<id> layers that specific imported model's own transforms on
  // top, exactly as engine.ts's buildChain does for a live request — omit it
  // to see the provider-level defaults every model starts from.
  r.get("/providers/:id/transforms/resolved", requireAdmin, (req, res) => {
    const provider = getProvider(db, String(req.params.id));
    if (!provider)
      return res.status(404).json({ error: { message: "not found" } });
    const upstreamId = str(req.query.upstreamId);
    const imported = upstreamId
      ? getProviderModel(db, provider.id, upstreamId)
      : null;
    try {
      res.json(
        resolveProviderTransforms(provider, imported?.transforms ?? undefined),
      );
    } catch (e) {
      res.status(500).json({ error: { message: (e as Error).message } });
    }
  });

  // --- provider catalog (stock provider registry) ---
  // Static list of provider templates the Add-Provider wizard renders.
  r.get("/provider-catalog", requireAdmin, (_req, res) =>
    res.json(listProviderTemplates()),
  );

  // Pre-create connectivity test + upstream model discovery. Lets the wizard
  // test a provider BEFORE its row exists, from an ad-hoc config. Reuses the
  // same probe helpers as the saved-provider test.
  r.post("/provider-catalog/test", requireAdmin, async (req, res) => {
    const b = (req.body || {}) as Record<string, unknown>;
    const baseUrl = str(b.baseUrl);
    if (!baseUrl)
      return res
        .status(400)
        .json({ error: { message: "baseUrl is required" } });
    const apiKey = str(b.apiKey);
    const probe: ProviderLike = {
      baseUrl,
      host: b.host == null ? null : (str(b.host) ?? null),
      apiKeys: apiKey ? [apiKey] : [],
      authScheme:
        b.authScheme === "bearer" ||
        b.authScheme === "xapikey" ||
        b.authScheme === "both" ||
        b.authScheme === "passthrough"
          ? (b.authScheme as AuthScheme)
          : "bearer",
      tlsVerify: b.tlsVerify === undefined ? true : !!b.tlsVerify,
      extraHeaders:
        b.extraHeaders && typeof b.extraHeaders === "object"
          ? (b.extraHeaders as Record<string, string>)
          : {},
      // Normalized here (not just at persist-time in createProvider/updateProvider)
      // so an ad-hoc pre-create probe composes the SAME URL a saved provider
      // would — a trailing slash or missing leading slash from a caller no
      // longer produces a malformed request (double slashes, or a suffix glued
      // on with no separator) that the persisted path wouldn't have shown.
      basePath: normBasePath(str(b.basePath)),
      modelsPath: str(b.modelsPath) ?? "/v1/models",
      proxy: b.proxy == null ? null : str(b.proxy),
      // Leave unset (not defaulted to "openai") when the caller doesn't pin a
      // dialect — the wizard never sends one, and fetchUpstreamModels() probes
      // the richer Anthropic dialect first in that case, falling back to
      // OpenAI's bare shape. Only pin here when the caller is explicit.
      format:
        b.format === "anthropic" || b.format === "openai"
          ? b.format
          : undefined,
    };
    try {
      const result = await testProviderAdhoc(probe);
      // Best-effort model discovery; failures don't fail the test. Returns the
      // universal list so the wizard imports rich metadata (context/max-out/
      // capabilities), same as the standalone importer.
      let models: UpstreamModel[] = [];
      if (result.ok) {
        try {
          models = await fetchUpstreamModels(probe);
        } catch {
          models = [];
        }
      }
      res.json({ ...result, models });
    } catch (e) {
      res.json({
        ok: false,
        status: null,
        ms: 0,
        error: (e as Error).message,
        models: [],
      });
    }
  });

  // --- imported provider models (per-provider catalog, not exposed) ---
  r.get("/providers/:id/models", requireAdmin, (req, res) =>
    res.json(listProviderModels(db, String(req.params.id))),
  );

  r.post("/providers/:id/models", requireAdmin, (req, res) => {
    try {
      const providerId = String(req.params.id);
      const provider = getProvider(db, providerId);
      if (!provider)
        return res
          .status(404)
          .json({ error: { message: "provider not found" } });
      const b = (req.body || {}) as Record<string, unknown>;
      const upstreamId = str(b.upstreamId);
      if (!upstreamId)
        return res
          .status(400)
          .json({ error: { message: "upstreamId is required" } });
      // Store ONLY the caller's own transforms — family/adapter defaults are no
      // longer baked into the stored config (see docs/transforms-api.md § The
      // default provider transform stack). They still apply to every request
      // as an always-on base layer, recomputed live in engine.ts's buildChain,
      // and are visible read-only via GET /providers/:id/transforms/resolved —
      // so a fresh import shows the same effective behavior as before, it's
      // just not copied into this row's editable JSON anymore.
      const transforms = parseTransformConfig(b.transforms);
      const pm = upsertProviderModel(db, {
        providerId,
        upstreamId,
        displayName: b.displayName == null ? null : str(b.displayName),
        contextWindow: b.contextWindow == null ? null : num(b.contextWindow),
        maxOutputTokens:
          b.maxOutputTokens == null ? null : num(b.maxOutputTokens),
        capabilities:
          b.capabilities == null ? null : parseCapabilities(b.capabilities),
        transforms,
        notes: b.notes == null ? null : str(b.notes),
      });
      res.status(201).json(pm);
    } catch (e) {
      bad(res, e);
    }
  });

  r.put("/providers/:id/models/:mid", requireAdmin, (req, res) => {
    try {
      const mid = Number(req.params.mid);
      const existing = getProviderModelById(db, mid);
      if (!existing || existing.providerId !== String(req.params.id))
        return res.status(404).json({ error: { message: "not found" } });
      const b = (req.body || {}) as Record<string, unknown>;
      const pm = updateProviderModel(db, mid, {
        displayName:
          b.displayName === undefined
            ? undefined
            : b.displayName == null
              ? null
              : str(b.displayName),
        contextWindow:
          b.contextWindow === undefined
            ? undefined
            : b.contextWindow == null
              ? null
              : num(b.contextWindow),
        maxOutputTokens:
          b.maxOutputTokens === undefined
            ? undefined
            : b.maxOutputTokens == null
              ? null
              : num(b.maxOutputTokens),
        capabilities:
          b.capabilities === undefined
            ? undefined
            : b.capabilities == null
              ? null
              : parseCapabilities(b.capabilities),
        transforms:
          b.transforms === undefined
            ? undefined
            : parseTransformConfig(b.transforms),
        notes:
          b.notes === undefined
            ? undefined
            : b.notes == null
              ? null
              : str(b.notes),
      });
      router.reload();
      broadcast(["providers", "models"], "provider-model:update");
      res.json(pm);
    } catch (e) {
      bad(res, e);
    }
  });

  r.delete("/providers/:id/models/:mid", requireAdmin, (req, res) => {
    const mid = Number(req.params.mid);
    const existing = getProviderModelById(db, mid);
    if (!existing || existing.providerId !== String(req.params.id))
      return res.status(404).json({ error: { message: "not found" } });
    deleteProviderModel(db, mid);
    router.reload();
    broadcast(["providers", "models"], "provider-model:delete");
    res.status(204).end();
  });

  // Probe ONE imported model via the adapter's testModel() seam (currently a
  // dummy stub on every adapter until one wires a real request — see
  // ProviderAdapter.testModel). The Imported Models table's per-row "Test"
  // button.
  r.post("/providers/:id/models/:mid/test", requireAdmin, async (req, res) => {
    const providerId = String(req.params.id);
    const provider = getProvider(db, providerId);
    if (!provider)
      return res.status(404).json({ error: { message: "provider not found" } });
    const mid = Number(req.params.mid);
    const pm = getProviderModelById(db, mid);
    if (!pm || pm.providerId !== providerId)
      return res.status(404).json({ error: { message: "model not found" } });
    try {
      const result = await testProviderModel(
        provider,
        pm.upstreamId,
        db,
        logger,
        pm.transforms,
      );
      res.json(result);
    } catch (e) {
      res.json({
        ok: false,
        status: null,
        data: { message: (e as Error).message },
        ms: 0,
      });
    }
  });
}
