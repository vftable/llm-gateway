// Upstream key-pool health + round-robin selection.
//
// Ported from vsllm-proxy's key-selection logic (selectKey / recordSuccess /
// recordFailure / clearAffinity) but on a ROUND-ROBIN base instead of random,
// and with the health state persisted to SQLite so cooldowns / auth-fails
// survive a restart. Pure of the request path: the engine calls `select` to
// choose a key and `record*` to feed back the outcome.
//
// Selection priority (per request, `tried` = key hashes already used this call):
//   1. the STICKY key for this model, if fresh (not tried, not auth-failed,
//      not rate-limited) — the last key that successfully served this exact
//      model, reused as-is instead of round-robin/affinity-pool picking, so
//      repeat requests concentrate on one key (better provider-side
//      prompt-cache hit rates, predictable per-key rate-limit budgeting)
//      rather than spreading evenly across the whole pool;
//   2. else round-robin among FRESH keys (not tried, not auth-failed, not
//      rate-limited), preferring keys already PROVEN for this model (affinity)
//      — the FIRST key to win this pool becomes the new sticky key for the
//      model (see recordSuccess);
//   3. else the untried non-auth-failed key whose cooldown expires soonest;
//   4. else round-robin among non-auth-failed;
//   5. else round-robin among all.
// A key falls out of "sticky" (back to step 2's pool) the moment it goes
// unhealthy (auth-failed/rate-limited) or its (key,model) affinity is
// evicted after repeated failures — see markAuthFailed/recordFailure.

import crypto from "crypto";
import type { Database as DB } from "better-sqlite3";
import { FABLE_MYTHOS_RE } from "../formats/model-version";

// HTTP statuses that mark a key rate-limited / auth-failed. (Retryable statuses
// live in the engine; these two sets drive key health specifically.)
export const RATE_LIMIT_STATUS = 429;
export const AUTH_FAIL_STATUS = new Set([401, 403]);

// Default failures-on-a-proven-pair before we evict the (key,model) affinity.
const DEFAULT_AFFINITY_FAIL_THRESHOLD = 3;

export interface KeyPick {
  key: string;
  keyHash: string;
  index: number;
}

interface HealthRow {
  rateLimitedUntil: number;
  authFailed: boolean;
  lastErrorStatus: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** Lifetime count of 401/403 responses — survives recordSuccess clearing
   *  the `authFailed` flag, since it's a history counter, not current state. */
  authFailCount: number;
}

export interface KeyHealthSnapshot {
  keyHash: string;
  rateLimitedUntil: number;
  rateLimitedUntilIso: string | null;
  authFailed: boolean;
  lastErrorStatus: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  usable: boolean;
  authFailCount: number;
}

export interface RateLimitHint {
  ms: number;
  resetAt: number;
  source: string;
}

interface ModelCooldownRow {
  cooldownUntil: number;
  lastErrorStatus: number | null;
  lastError: string | null;
}

// Hash a raw key to a stable short id (never persist the raw key here).
export function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const exact = headers[name];
  if (exact !== undefined) return Array.isArray(exact) ? exact[0] : exact;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

function parsePositiveNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function delayHint(ms: number, source: string, now: number): RateLimitHint {
  const safeMs = Math.max(0, Math.round(ms));
  return { ms: safeMs, resetAt: now + safeMs, source };
}

// Parse an upstream rate-limit hint into a cooldown. Prefer standard headers,
// but understand the de-facto variants providers use in practice:
// retry-after-ms -> retry-after (seconds/date) -> x-ratelimit-reset-ms
// (epoch ms) -> x-ratelimit-reset / x-rate-limit-reset (usually epoch seconds)
// -> ratelimit-reset (RFC delay seconds) -> anthropic-ratelimit-unified-reset
// (epoch seconds; Anthropic's own unified-quota reset, sent on a 429 from
// their 5h/7d subscription limiter — see services/anthropic-unified-usage.ts)
// -> default 60s.
export function parseRateLimitHint(
  headers: Record<string, string | string[] | undefined>,
  now: number = Date.now(),
): RateLimitHint {
  const retryAfterMs = parsePositiveNumber(
    headerValue(headers, "retry-after-ms"),
  );
  if (retryAfterMs !== null)
    return delayHint(retryAfterMs, "retry-after-ms", now);

  const retryAfter = headerValue(headers, "retry-after");
  if (retryAfter) {
    const trimmed = retryAfter.trim();
    const seconds = parsePositiveNumber(trimmed);
    if (seconds !== null) return delayHint(seconds * 1000, "retry-after", now);
    const when = Date.parse(trimmed);
    if (!Number.isNaN(when))
      return delayHint(Math.max(0, when - now), "retry-after-date", now);
  }

  const resetMs = parsePositiveNumber(
    headerValue(headers, "x-ratelimit-reset-ms"),
  );
  if (resetMs !== null)
    return delayHint(Math.max(0, resetMs - now), "x-ratelimit-reset-ms", now);

  for (const name of ["x-ratelimit-reset", "x-rate-limit-reset"]) {
    const raw = parsePositiveNumber(headerValue(headers, name));
    if (raw !== null) {
      // These headers are usually Unix seconds. If a provider sends a tiny
      // value, treat it as a relative delay rather than an epoch in 1970.
      const resetAt = raw > 1_000_000_000 ? raw * 1000 : now + raw * 1000;
      return delayHint(Math.max(0, resetAt - now), name, now);
    }
  }

  const standardReset = parsePositiveNumber(
    headerValue(headers, "ratelimit-reset"),
  );
  if (standardReset !== null)
    return delayHint(standardReset * 1000, "ratelimit-reset", now);

  // Anthropic's own unified-quota reset (epoch seconds), for a Claude Code /
  // subscription 429 that carries no standard rate-limit header at all.
  const unifiedReset = parsePositiveNumber(
    headerValue(headers, "anthropic-ratelimit-unified-reset"),
  );
  if (unifiedReset !== null)
    return delayHint(
      Math.max(0, unifiedReset * 1000 - now),
      "anthropic-ratelimit-unified-reset",
      now,
    );

  return delayHint(60_000, "default", now);
}

export function parseRateLimit(
  headers: Record<string, string | string[] | undefined>,
  now: number = Date.now(),
): number {
  return parseRateLimitHint(headers, now).ms;
}

export class KeyHealthStore {
  private cursor = new Map<string, number>(); // providerId -> next rotation index
  private health = new Map<string, HealthRow>(); // `${providerId}|${keyHash}`
  private affinity = new Map<string, Set<string>>(); // `${providerId}|${keyHash}` -> proven models
  private affinityFails = new Map<string, number>(); // `${providerId}|${keyHash}|${model}` -> fails
  private sticky = new Map<string, string>(); // `${providerId}|${model}` -> keyHash
  private modelCooldowns = new Map<string, ModelCooldownRow>();
  private loaded = new Set<string>(); // providerIds hydrated from DB

  constructor(
    private readonly db: DB,
    private readonly now: () => number = Date.now,
    private readonly affinityFailThreshold = DEFAULT_AFFINITY_FAIL_THRESHOLD,
  ) {}

  private hk(providerId: string, keyHash: string): string {
    return `${providerId}|${keyHash}`;
  }

  private mk(providerId: string, model: string): string {
    return `${providerId}|${model}`;
  }

  private modelClass(model: string | null | undefined): string | null {
    // Both families consume the unified 7d_oi quota. Keep the stored class name
    // "fable" so existing UI/status language and persisted rows stay stable.
    return model && FABLE_MYTHOS_RE.test(model) ? "fable" : null;
  }

  private ck(providerId: string, keyHash: string, modelClass: string): string {
    return `${providerId}|${keyHash}|${modelClass}`;
  }

  private modelCooldownUntil(
    providerId: string,
    keyHash: string,
    model: string | null | undefined,
  ): number {
    const modelClass = this.modelClass(model);
    if (!modelClass) return 0;
    return (
      this.modelCooldowns.get(this.ck(providerId, keyHash, modelClass))
        ?.cooldownUntil ?? 0
    );
  }

  private readyAt(
    providerId: string,
    keyHash: string,
    model: string | null | undefined,
  ): number {
    return Math.max(
      this.getHealth(providerId, keyHash).rateLimitedUntil,
      this.modelCooldownUntil(providerId, keyHash, model),
    );
  }

  // Lazily hydrate a provider's health + affinity from SQLite on first use.
  private ensureLoaded(providerId: string): void {
    if (this.loaded.has(providerId)) return;
    this.loaded.add(providerId);
    try {
      const hrows = this.db
        .prepare(
          "SELECT key_hash, rate_limited_until, auth_failed, last_error_status, last_error, last_error_at, auth_fail_count FROM provider_key_health WHERE provider_id = ?",
        )
        .all(providerId) as Array<{
        key_hash: string;
        rate_limited_until: number;
        auth_failed: number;
        last_error_status: number | null;
        last_error: string | null;
        last_error_at: string | null;
        auth_fail_count: number;
      }>;
      for (const r of hrows)
        this.health.set(this.hk(providerId, r.key_hash), {
          rateLimitedUntil: r.rate_limited_until,
          authFailed: !!r.auth_failed,
          lastErrorStatus: r.last_error_status,
          lastError: r.last_error,
          lastErrorAt: r.last_error_at,
          authFailCount: r.auth_fail_count,
        });
      const arows = this.db
        .prepare(
          "SELECT key_hash, model, fails FROM key_model_affinity WHERE provider_id = ?",
        )
        .all(providerId) as Array<{
        key_hash: string;
        model: string;
        fails: number;
      }>;
      for (const r of arows) {
        const k = this.hk(providerId, r.key_hash);
        if (!this.affinity.has(k)) this.affinity.set(k, new Set());
        this.affinity.get(k)!.add(r.model);
        this.affinityFails.set(`${k}|${r.model}`, r.fails);
      }
      const srows = this.db
        .prepare(
          "SELECT model, key_hash FROM key_model_sticky WHERE provider_id = ?",
        )
        .all(providerId) as Array<{ model: string; key_hash: string }>;
      for (const r of srows)
        this.sticky.set(this.mk(providerId, r.model), r.key_hash);
      const crows = this.db
        .prepare(
          "SELECT key_hash, model_class, cooldown_until, last_error_status, last_error FROM provider_key_model_cooldown WHERE provider_id = ?",
        )
        .all(providerId) as Array<{
        key_hash: string;
        model_class: string;
        cooldown_until: number;
        last_error_status: number | null;
        last_error: string | null;
      }>;
      for (const r of crows)
        this.modelCooldowns.set(
          this.ck(providerId, r.key_hash, r.model_class),
          {
            cooldownUntil: r.cooldown_until,
            lastErrorStatus: r.last_error_status,
            lastError: r.last_error,
          },
        );
    } catch {
      /* health is best-effort; a read failure just means an empty slate */
    }
  }

  private getHealth(providerId: string, keyHash: string): HealthRow {
    const k = this.hk(providerId, keyHash);
    let h = this.health.get(k);
    if (!h) {
      h = {
        rateLimitedUntil: 0,
        authFailed: false,
        lastErrorStatus: null,
        lastError: null,
        lastErrorAt: null,
        authFailCount: 0,
      };
      this.health.set(k, h);
    }
    return h;
  }

  private persistHealth(providerId: string, keyHash: string): void {
    const h = this.getHealth(providerId, keyHash);
    try {
      this.db
        .prepare(
          `INSERT INTO provider_key_health
             (provider_id, key_hash, rate_limited_until, auth_failed, last_error_status, last_error, last_error_at, auth_fail_count, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider_id, key_hash) DO UPDATE SET
             rate_limited_until=excluded.rate_limited_until,
             auth_failed=excluded.auth_failed,
             last_error_status=excluded.last_error_status,
             last_error=excluded.last_error,
             last_error_at=excluded.last_error_at,
             auth_fail_count=excluded.auth_fail_count,
             updated_at=excluded.updated_at`,
        )
        .run(
          providerId,
          keyHash,
          h.rateLimitedUntil,
          h.authFailed ? 1 : 0,
          h.lastErrorStatus,
          h.lastError,
          h.lastErrorAt,
          h.authFailCount,
          new Date(this.now()).toISOString(),
        );
    } catch {
      /* best-effort */
    }
  }

  // Choose a key for this attempt. Returns null only when the provider has no
  // keys at all (a keyless provider still routes — the engine sends no auth).
  select(
    providerId: string,
    keys: string[],
    model: string | null,
    tried: Set<string>,
  ): KeyPick | null {
    if (!keys.length) return null;
    this.ensureLoaded(providerId);
    const now = this.now();
    const hashes = keys.map(hashKey);
    const idx = keys.map((_, i) => i);

    const isFresh = (i: number) => {
      const h = this.getHealth(providerId, hashes[i]);
      return (
        !tried.has(hashes[i]) &&
        !h.authFailed &&
        this.readyAt(providerId, hashes[i], model) <= now
      );
    };

    // Sticky key for this model, if it's still fresh — cache locality wins
    // over spreading load, as long as the proven key is actually healthy.
    if (model) {
      const stuckHash = this.sticky.get(this.mk(providerId, model));
      if (stuckHash) {
        const i = hashes.indexOf(stuckHash);
        if (i !== -1 && isFresh(i))
          return { key: keys[i], keyHash: hashes[i], index: i };
      }
    }

    const fresh = idx.filter(isFresh);
    if (fresh.length) {
      if (model) {
        const proven = fresh.filter((i) =>
          this.affinity.get(this.hk(providerId, hashes[i]))?.has(model),
        );
        if (proven.length) return this.rrPick(providerId, proven, keys, hashes);
      }
      return this.rrPick(providerId, fresh, keys, hashes);
    }

    // No fresh key: try an untried non-auth-failed one (may be cooling down),
    // choosing the soonest to recover.
    const untried = idx.filter(
      (i) =>
        !tried.has(hashes[i]) &&
        !this.getHealth(providerId, hashes[i]).authFailed,
    );
    if (untried.length) {
      const best = untried.reduce((a, b) =>
        this.readyAt(providerId, hashes[a], model) <=
        this.readyAt(providerId, hashes[b], model)
          ? a
          : b,
      );
      return { key: keys[best], keyHash: hashes[best], index: best };
    }

    // Everything tried or auth-failed: prefer any non-auth-failed, else any.
    const nonAuth = idx.filter(
      (i) => !this.getHealth(providerId, hashes[i]).authFailed,
    );
    const pool = nonAuth.length ? nonAuth : idx;
    return this.rrPick(providerId, pool, keys, hashes);
  }

  // Round-robin pick: advance a per-provider cursor over the full key list and
  // return the next index that is in `pool`, so load spreads evenly.
  private rrPick(
    providerId: string,
    pool: number[],
    keys: string[],
    hashes: string[],
  ): KeyPick {
    const n = keys.length;
    const start = this.cursor.get(providerId) ?? 0;
    const set = new Set(pool);
    for (let step = 0; step < n; step++) {
      const cand = (start + step) % n;
      if (set.has(cand)) {
        this.cursor.set(providerId, (cand + 1) % n);
        return { key: keys[cand], keyHash: hashes[cand], index: cand };
      }
    }
    const cand = pool[0];
    return { key: keys[cand], keyHash: hashes[cand], index: cand };
  }

  // A key served this model: clear any auth-fail flag, reset the failure
  // counter, and learn the (key,model) affinity.
  recordSuccess(
    providerId: string,
    keyHash: string,
    model: string | null,
  ): void {
    const h = this.getHealth(providerId, keyHash);
    if (h.authFailed || h.rateLimitedUntil || h.lastError) {
      h.authFailed = false;
      h.rateLimitedUntil = 0;
      h.lastErrorStatus = null;
      h.lastError = null;
      h.lastErrorAt = null;
      this.persistHealth(providerId, keyHash);
    }
    if (!model) return;
    const k = this.hk(providerId, keyHash);
    if (!this.affinity.has(k)) this.affinity.set(k, new Set());
    const set = this.affinity.get(k)!;
    this.affinityFails.set(`${k}|${model}`, 0);
    if (!set.has(model)) {
      set.add(model);
    }
    this.persistAffinity(providerId, keyHash, model, 0);
    // This key just proved itself for this model — make it (or re-confirm
    // it as) the sticky pick so subsequent requests for this model reuse it
    // instead of round-robining to a different key.
    const mkey = this.mk(providerId, model);
    if (this.sticky.get(mkey) !== keyHash) {
      this.sticky.set(mkey, keyHash);
      this.persistSticky(providerId, model, keyHash);
    }
  }

  // A proven (key,model) pair failed: bump its counter and evict once it
  // crosses the threshold. Unproven pairs are ignored (nothing to demote).
  recordFailure(
    providerId: string,
    keyHash: string,
    model: string | null,
  ): void {
    if (!model) return;
    const k = this.hk(providerId, keyHash);
    if (!this.affinity.get(k)?.has(model)) return;
    const fk = `${k}|${model}`;
    const fails = (this.affinityFails.get(fk) ?? 0) + 1;
    if (fails >= this.affinityFailThreshold) {
      this.affinity.get(k)!.delete(model);
      this.affinityFails.delete(fk);
      this.deleteAffinity(providerId, keyHash, model);
      this.clearStickyIfPointsTo(providerId, model, keyHash);
    } else {
      this.affinityFails.set(fk, fails);
      this.persistAffinity(providerId, keyHash, model, fails);
    }
  }

  private recordError(
    providerId: string,
    keyHash: string,
    status: number | null,
    error: string | null,
  ): HealthRow {
    const h = this.getHealth(providerId, keyHash);
    h.lastErrorStatus = status;
    h.lastError = error ? error.slice(0, 500) : null;
    h.lastErrorAt = new Date(this.now()).toISOString();
    return h;
  }

  // Rate-limit a key for `ms` (from parseRateLimit).
  markRateLimited(
    providerId: string,
    keyHash: string,
    ms: number,
    status = RATE_LIMIT_STATUS,
    error: string | null = null,
  ): void {
    if (ms <= 0) return;
    const h = this.recordError(providerId, keyHash, status, error);
    h.rateLimitedUntil = this.now() + ms;
    this.persistHealth(providerId, keyHash);
  }

  // Cool down one model class without taking the key away from unrelated
  // traffic. Used for Claude Code's Fable-only 7d_oi quota window.
  markModelCooldown(
    providerId: string,
    keyHash: string,
    modelClass: string,
    ms: number,
    status = RATE_LIMIT_STATUS,
    error: string | null = null,
  ): void {
    if (ms <= 0) return;
    const row: ModelCooldownRow = {
      cooldownUntil: this.now() + ms,
      lastErrorStatus: status,
      lastError: error ? error.slice(0, 500) : null,
    };
    this.modelCooldowns.set(this.ck(providerId, keyHash, modelClass), row);
    try {
      this.db
        .prepare(
          `INSERT INTO provider_key_model_cooldown
             (provider_id, key_hash, model_class, cooldown_until, last_error_status, last_error, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider_id, key_hash, model_class) DO UPDATE SET
             cooldown_until=excluded.cooldown_until,
             last_error_status=excluded.last_error_status,
             last_error=excluded.last_error,
             updated_at=excluded.updated_at`,
        )
        .run(
          providerId,
          keyHash,
          modelClass,
          row.cooldownUntil,
          row.lastErrorStatus,
          row.lastError,
          new Date(this.now()).toISOString(),
        );
    } catch {
      /* best-effort */
    }
  }

  clearAllRateLimits(): {
    keysCleared: number;
    modelCooldownsCleared: number;
  } {
    const clear = this.db.transaction(() => {
      const keysCleared = this.db
        .prepare(
          "UPDATE provider_key_health SET rate_limited_until = 0, updated_at = ? WHERE rate_limited_until > 0",
        )
        .run(new Date(this.now()).toISOString()).changes;
      const modelCooldownsCleared = this.db
        .prepare("DELETE FROM provider_key_model_cooldown")
        .run().changes;
      return { keysCleared, modelCooldownsCleared };
    });
    const result = clear();
    for (const health of this.health.values()) health.rateLimitedUntil = 0;
    this.modelCooldowns.clear();
    return result;
  }

  // Disable a key after an auth failure and drop its affinity.
  markAuthFailed(
    providerId: string,
    keyHash: string,
    status: number | null = null,
    error: string | null = null,
  ): void {
    const h = this.recordError(providerId, keyHash, status, error);
    h.authFailed = true;
    h.authFailCount += 1;
    this.persistHealth(providerId, keyHash);
    this.clearAffinity(providerId, keyHash);
  }

  private clearAffinity(providerId: string, keyHash: string): void {
    const k = this.hk(providerId, keyHash);
    const set = this.affinity.get(k);
    if (set) {
      for (const m of set) {
        this.affinityFails.delete(`${k}|${m}`);
        this.clearStickyIfPointsTo(providerId, m, keyHash);
      }
      set.clear();
    }
    try {
      this.db
        .prepare(
          "DELETE FROM key_model_affinity WHERE provider_id = ? AND key_hash = ?",
        )
        .run(providerId, keyHash);
    } catch {
      /* best-effort */
    }
  }

  // A key just lost affinity for `model` (evicted after repeated failures,
  // or wiped entirely on a confirmed auth failure) — stop preferring it as
  // the sticky pick for that model so the next select() falls through to the
  // normal fresh/proven pool instead of reusing a key that just proved
  // itself unreliable.
  private clearStickyIfPointsTo(
    providerId: string,
    model: string,
    keyHash: string,
  ): void {
    const mkey = this.mk(providerId, model);
    if (this.sticky.get(mkey) !== keyHash) return;
    this.sticky.delete(mkey);
    try {
      this.db
        .prepare(
          "DELETE FROM key_model_sticky WHERE provider_id = ? AND model = ? AND key_hash = ?",
        )
        .run(providerId, model, keyHash);
    } catch {
      /* best-effort */
    }
  }

  private persistSticky(
    providerId: string,
    model: string,
    keyHash: string,
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO key_model_sticky (provider_id, model, key_hash, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(provider_id, model) DO UPDATE SET
             key_hash=excluded.key_hash,
             updated_at=excluded.updated_at`,
        )
        .run(providerId, model, keyHash, new Date(this.now()).toISOString());
    } catch {
      /* best-effort */
    }
  }

  // How many keys are currently usable (not auth-failed, not cooling down).
  // Used by the engine to bound per-provider attempts so a rate-limited key can
  // fail over to a healthy one within a single request.
  usableCount(
    providerId: string,
    keys: string[],
    model: string | null = null,
  ): number {
    if (!keys.length) return 0;
    this.ensureLoaded(providerId);
    const now = this.now();
    return keys.filter((key) => {
      const keyHash = hashKey(key);
      const h = this.getHealth(providerId, keyHash);
      return !h.authFailed && this.readyAt(providerId, keyHash, model) <= now;
    }).length;
  }

  snapshot(providerId: string, keyHash: string): KeyHealthSnapshot {
    this.ensureLoaded(providerId);
    const h = this.getHealth(providerId, keyHash);
    const now = this.now();
    return {
      keyHash,
      rateLimitedUntil: h.rateLimitedUntil,
      rateLimitedUntilIso:
        h.rateLimitedUntil > now
          ? new Date(h.rateLimitedUntil).toISOString()
          : null,
      authFailed: h.authFailed,
      lastErrorStatus: h.lastErrorStatus,
      lastError: h.lastError,
      lastErrorAt: h.lastErrorAt,
      usable: !h.authFailed && h.rateLimitedUntil <= now,
      authFailCount: h.authFailCount,
    };
  }

  snapshots(providerId: string, keyHashes: string[]): KeyHealthSnapshot[] {
    return keyHashes.map((h) => this.snapshot(providerId, h));
  }

  nextReadyAt(
    providerId: string,
    keys: string[],
    model: string | null = null,
  ): number | null {
    if (!keys.length) return null;
    this.ensureLoaded(providerId);
    const now = this.now();
    const candidates = keys
      .map((key) => {
        const keyHash = hashKey(key);
        const health = this.getHealth(providerId, keyHash);
        return health.authFailed
          ? null
          : this.readyAt(providerId, keyHash, model);
      })
      .filter(
        (readyAt): readyAt is number => readyAt !== null && readyAt > now,
      );
    return candidates.length ? Math.min(...candidates) : null;
  }

  private persistAffinity(
    providerId: string,
    keyHash: string,
    model: string,
    fails: number,
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO key_model_affinity (provider_id, key_hash, model, fails)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(provider_id, key_hash, model) DO UPDATE SET fails=excluded.fails`,
        )
        .run(providerId, keyHash, model, fails);
    } catch {
      /* best-effort */
    }
  }

  private deleteAffinity(
    providerId: string,
    keyHash: string,
    model: string,
  ): void {
    try {
      this.db
        .prepare(
          "DELETE FROM key_model_affinity WHERE provider_id = ? AND key_hash = ? AND model = ?",
        )
        .run(providerId, keyHash, model);
    } catch {
      /* best-effort */
    }
  }
}
