// Background key sync service: polls configured URLs on a per-provider
// timer and reconciles the provider_keys table via importKeysFromUrl.
// The URL response is the source of truth — keys not in the response get
// disabled (not deleted), preserving health/affinity data. Keys that
// reappear are re-enabled automatically.

import type { Database as DB } from "better-sqlite3";
import type { Logger } from "../logger";
import {
  listKeySyncConfigs,
  updateSyncStatus,
  type ProviderKeySyncConfig,
} from "../repo/provider-keys";
import { importKeysFromUrl } from "./key-import";

export class KeySyncService {
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private db: DB,
    private logger: Logger,
    private onSync: () => void,
  ) {}

  start(): void {
    for (const config of listKeySyncConfigs(this.db)) {
      this.scheduleTimer(config);
    }
    this.logger.info("key_sync_started", { providers: this.timers.size });
  }

  register(config: ProviderKeySyncConfig): void {
    this.clearTimer(config.providerId);
    if (config.enabled) {
      this.scheduleTimer(config);
    }
  }

  unregister(providerId: string): void {
    this.clearTimer(providerId);
  }

  stop(): void {
    for (const [, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  private scheduleTimer(config: ProviderKeySyncConfig): void {
    const intervalMs = config.pollIntervalSec * 1000;
    const timer = setInterval(() => this.poll(config), intervalMs);
    if (typeof (timer as { unref?: () => void }).unref === "function")
      (timer as { unref: () => void }).unref();
    this.timers.set(config.providerId, timer);
  }

  private clearTimer(providerId: string): void {
    const timer = this.timers.get(providerId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(providerId);
    }
  }

  private async poll(config: ProviderKeySyncConfig): Promise<void> {
    const now = new Date().toISOString();
    try {
      const result = await importKeysFromUrl(
        this.db,
        config.providerId,
        config.pollUrl,
        { headers: config.pollHeaders, mode: "replace" },
      );
      updateSyncStatus(this.db, config.providerId, now, null);
      this.logger.info("key_sync_ok", {
        providerId: config.providerId,
        added: result.batch.added,
        disabled: result.batch.disabled,
        enabled: result.batch.enabled,
        fetched: result.fetched,
      });
      this.onSync();
    } catch (err) {
      const msg = (err as Error).message;
      updateSyncStatus(this.db, config.providerId, now, msg);
      this.logger.warn("key_sync_failed", {
        providerId: config.providerId,
        error: msg,
      });
    }
  }
}
