// Per-API-key daily token usage tracker with JSON-file persistence.
//
// Each tracked key has a { tokens, day } record. `day` is the current UTC
// date (YYYY-MM-DD) — when it advances past the stored day, the counter
// resets to 0. The whole store is written through to a JSON file
// (default ./usage.json) so limits survive process restarts.
//
// Writes are debounced so a burst of requests doesn't cause a synchronous
// disk write per call. The gateway also calls flushSync() on SIGINT/SIGTERM
// so the final state isn't lost.
//
// Used by the gateway middleware to enforce per-key tokensPerDay quotas.

import fs from "fs";
import path from "path";

export interface KeyUsage {
  tokens: number;
  day: string; // YYYY-MM-DD (UTC)
}

export type UsageStore = Record<string, KeyUsage>;

// Debounce writes so a burst of requests doesn't cause a write per call.
const WRITE_DEBOUNCE_MS = 500;
// Hard upper bound on deferral. After this, a write is forced even if more
// mutations keep arriving.
const WRITE_MAX_DELAY_MS = 2000;

export class UsageTracker {
  private store: UsageStore = {};
  private readonly filePath: string;
  private writeTimer: NodeJS.Timeout | null = null;
  private firstScheduledAt = 0;
  private dirty = false;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (err) {
      // Missing file is the normal first-run case; anything else we swallow
      // and start fresh. The next save will overwrite the corrupt file.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // best-effort; fall through to empty store
      }
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.store = parsed as UsageStore;
      }
    } catch {
      // Corrupt JSON — start empty.
    }
  }

  private scheduleWrite(): void {
    this.dirty = true;
    const now = Date.now();
    if (this.writeTimer) {
      // If we still have headroom under the max-delay cap, slide the timer
      // forward to keep coalescing. Otherwise let the existing timer fire.
      if (now - this.firstScheduledAt < WRITE_MAX_DELAY_MS - WRITE_DEBOUNCE_MS) {
        clearTimeout(this.writeTimer);
      } else {
        return;
      }
    } else {
      this.firstScheduledAt = now;
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flushSync();
    }, WRITE_DEBOUNCE_MS);
  }

  // Current UTC day as YYYY-MM-DD.
  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  // Read current usage for a key. Resets to zero if the day has rolled over.
  // Returns a copy so callers can inspect without mutating internal state.
  get(key: string): KeyUsage {
    const today = this.today();
    const u = this.store[key];
    if (!u || u.day !== today) return { tokens: 0, day: today };
    return { ...u };
  }

  // Add tokens to a key's daily counter. Resets on day rollover. No-op for
  // non-positive token counts.
  add(key: string, tokens: number): void {
    if (!key || tokens <= 0) return;
    const today = this.today();
    const u = this.store[key];
    if (!u || u.day !== today) {
      this.store[key] = { tokens, day: today };
    } else {
      u.tokens += tokens;
    }
    this.scheduleWrite();
  }

  // Subtract tokens (used to reconcile optimistic estimates with actual
  // upstream-reported usage). Clamps at 0 so a reconciliation error can't
  // push a counter negative.
  subtract(key: string, tokens: number): void {
    if (!key || tokens <= 0) return;
    const today = this.today();
    const u = this.store[key];
    if (!u || u.day !== today) return;
    u.tokens = Math.max(0, u.tokens - tokens);
    this.scheduleWrite();
  }

  // Flush pending writes to disk synchronously. Safe to call on process exit.
  flushSync(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Write to a temp file then rename, so a crash mid-write can't
      // leave the usage file truncated/corrupt.
      const tmp = this.filePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.store, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Persistence is best-effort. If the write fails, in-memory state
      // still works for the current process; we'll just restart from the
      // last successful save next launch.
    }
  }
}

// Compute the next UTC midnight (00:00 UTC of the following day) — the
// reset point for daily quotas. Exported for use in rate-limit responses.
export function nextUtcMidnight(): Date {
  const d = new Date();
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1),
  );
}
