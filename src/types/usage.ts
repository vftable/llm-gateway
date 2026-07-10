// Provider key-usage reporting.
//
// A standardized shape each provider adapter can populate to surface upstream
// consumption + rate limits for its API keys (5-hour and weekly windows, etc.).
// The gateway's own token counters live elsewhere (usage_breakdown); this is the
// UPSTREAM provider's view — how much of the provider's own quota a key has
// burned. Adapters that can't query real usage return placeholder data (dummy:
// true) so the dashboard has content until a real poller is wired in.

export type UsageUnit = "tokens" | "requests" | "credits";

export interface ProviderKeyUsageWindow {
  /** Stable id for the window ("5h", "weekly"). */
  id: string;
  /** Human label ("5-hour", "Weekly"). */
  label: string;
  used: number;
  limit: number;
  unit: UsageUnit;
  /** ISO timestamp when this window's counter resets. */
  resetsAt: string;
}

export interface ProviderKeyUsage {
  /** Masked key (head…tail) — never the raw secret. */
  keyMask: string;
  /** Whether this key is currently active (false = operator-disabled). */
  enabled: boolean;
  windows: ProviderKeyUsageWindow[];
  /**
   * True when the provider cannot report usage for this key (no usage endpoint,
   * or a live query failed). The UI shows an "Unavailable" state instead of bars.
   */
  unavailable?: boolean;
  /**
   * Optional free-text note for this key — e.g. "Rate limited until 3pm",
   * "Trial tier", or an error detail. Shown under the key on the usage view.
   */
  message?: string;
}

export interface ProviderUsageReport {
  providerId: string;
  providerName: string;
  catalogId: string | null;
  /** Adapter brand key (drives the card's vendor logo). */
  brand: string;
  /**
   * Whether the adapter reports upstream key usage at all (its supportsKeyUsage()
   * gate). False = the provider has no usage endpoint; the dashboard omits it
   * entirely rather than showing a card of empty keys. When false, `keys` is empty
   * (the per-key queries are skipped).
   */
  supported: boolean;
  /** True when the windows are placeholder values, not real upstream usage. */
  dummy: boolean;
  keys: ProviderKeyUsage[];
}
