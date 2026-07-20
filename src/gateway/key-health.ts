// Upstream key-pool health + round-robin selection.
//
// Ported from vsllm-proxy's key-selection logic (selectKey / recordSuccess /
// recordFailure / clearAffinity) but on a ROUND-ROBIN base instead of random,
// and with the health state persisted to SQLite so cooldowns / auth-fails
// survive a restart. Pure of the request path: the engine calls `select` to
// choose a key and `record*` to feed back the outcome.
//
// Selection priority (per request, `tried` = key hashes already used this call):
//   1. round-robin among FRESH keys (not tried, not auth-failed, not
//      rate-limited), preferring keys already PROVEN for this model (affinity);
//   2. else the untried non-auth-failed key whose cooldown expires soonest;
//   3. else round-robin among non-auth-failed;
//   4. else round-robin among all.

import crypto from "crypto";
import type { Database as DB } from "better-sqlite3";

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
}

// Hash a raw key to a stable short id (never persist the raw key here).
export function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
}

// Parse an upstream rate-limit hint into a cooldown in ms. Order matches vsllm:
// retry-after-ms -> retry-after (seconds or HTTP date) -> default 60s.
export function parseRateLimit(
  headers: Record<string, string | string[] | undefined>,
  now: number = Date.now(),
): number {
  const get = (n: string): string | undefined => {
    const v = headers[n];
    return Array.isArray(v) ? v[0] : v;
  };
  const ms = get("retry-after-ms");
  if (ms && /^\d+$/.test(ms.trim())) return Math.max(0, parseInt(ms, 10));
  const ra = get("retry-after");
  if (ra) {
    const s = ra.trim();
    if (/^\d+$/.test(s)) return Math.max(0, parseInt(s, 10) * 1000);
    const when = Date.parse(s);
    if (!Number.isNaN(when)) return Math.max(0, when - now);
  }
  return 60_000;
}

export class KeyHealthStore {
  private cursor = new Map<string, number>(); // providerId -> next rotation index
  private health = new Map<string, HealthRow>(); // `${providerId}|${keyHash}`
  private affinity = new Map<string, Set<string>>(); // `${providerId}|${keyHash}` -> proven models
  private affinityFails = new Map<string, number>(); // `${providerId}|${keyHash}|${model}` -> fails
  private loaded = new Set<string>(); // providerIds hydrated from DB

  constructor(
    private readonly db: DB,
    private readonly now: () => number = Date.now,
    private readonly affinityFailThreshold = DEFAULT_AFFINITY_FAIL_THRESHOLD,
  ) {}

  private hk(providerId: string, keyHash: string): string {
    return `${providerId}|${keyHash}`;
  }

  // Lazily hydrate a provider's health + affinity from SQLite on first use.
  private ensureLoaded(providerId: string): void {
    if (this.loaded.has(providerId)) return;
    this.loaded.add(providerId);
    try {
      const hrows = this.db
        .prepare(
          "SELECT key_hash, rate_limited_until, auth_failed FROM provider_key_health WHERE provider_id = ?",
        )
        .all(providerId) as Array<{
        key_hash: string;
        rate_limited_until: number;
        auth_failed: number;
      }>;
      for (const r of hrows)
        this.health.set(this.hk(providerId, r.key_hash), {
          rateLimitedUntil: r.rate_limited_until,
          authFailed: !!r.auth_failed,
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
    } catch {
      /* health is best-effort; a read failure just means an empty slate */
    }
  }

  private getHealth(providerId: string, keyHash: string): HealthRow {
    const k = this.hk(providerId, keyHash);
    let h = this.health.get(k);
    if (!h) {
      h = { rateLimitedUntil: 0, authFailed: false };
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
             (provider_id, key_hash, rate_limited_until, auth_failed, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(provider_id, key_hash) DO UPDATE SET
             rate_limited_until=excluded.rate_limited_until,
             auth_failed=excluded.auth_failed,
             updated_at=excluded.updated_at`,
        )
        .run(
          providerId,
          keyHash,
          h.rateLimitedUntil,
          h.authFailed ? 1 : 0,
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
        !tried.has(hashes[i]) && !h.authFailed && h.rateLimitedUntil <= now
      );
    };

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
        this.getHealth(providerId, hashes[a]).rateLimitedUntil <=
        this.getHealth(providerId, hashes[b]).rateLimitedUntil
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
    if (h.authFailed || h.rateLimitedUntil) {
      h.authFailed = false;
      h.rateLimitedUntil = 0;
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
    } else {
      this.affinityFails.set(fk, fails);
      this.persistAffinity(providerId, keyHash, model, fails);
    }
  }

  // Rate-limit a key for `ms` (from parseRateLimit).
  markRateLimited(providerId: string, keyHash: string, ms: number): void {
    if (ms <= 0) return;
    const h = this.getHealth(providerId, keyHash);
    h.rateLimitedUntil = this.now() + ms;
    this.persistHealth(providerId, keyHash);
  }

  // Disable a key after an auth failure and drop its affinity.
  markAuthFailed(providerId: string, keyHash: string): void {
    const h = this.getHealth(providerId, keyHash);
    h.authFailed = true;
    this.persistHealth(providerId, keyHash);
    this.clearAffinity(providerId, keyHash);
  }

  private clearAffinity(providerId: string, keyHash: string): void {
    const k = this.hk(providerId, keyHash);
    const set = this.affinity.get(k);
    if (set) {
      for (const m of set) this.affinityFails.delete(`${k}|${m}`);
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

  // How many keys are currently usable (not auth-failed, not cooling down).
  // Used by the engine to bound per-provider attempts so a rate-limited key can
  // fail over to a healthy one within a single request.
  usableCount(providerId: string, keys: string[]): number {
    if (!keys.length) return 0;
    this.ensureLoaded(providerId);
    const now = this.now();
    return keys.filter((key) => {
      const h = this.getHealth(providerId, hashKey(key));
      return !h.authFailed && h.rateLimitedUntil <= now;
    }).length;
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
