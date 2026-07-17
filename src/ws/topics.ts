// Maps each WsTopic to a data-fetcher that reuses the same repo functions
// the REST routes use, so WS push data is identical to REST response data.

import type { Database as DB } from "better-sqlite3";
import type { WsTopic } from "./schema";
import { dashboardStats } from "../repo/request-logs";
import {
  totalUsageHistory,
  hourlyUsageHistory,
  totalUsageToday,
  listUsageToday,
  fullBreakdownToday,
} from "../repo/usage";
import { listProviders } from "../repo/providers";
import { listModels } from "../repo/models";
import { listApiKeys } from "../repo/api-keys";
import { listUsers } from "../repo/users";
import { listRequestLogs, type ListOpts } from "../repo/request-logs";
import { getSettings } from "../repo/settings";

export function fetchTopic(
  db: DB,
  topic: WsTopic,
  params?: Record<string, string | number | boolean>,
): unknown {
  switch (topic) {
    case "overview":
      return {
        stats: dashboardStats(db),
        usageHistory: totalUsageHistory(db, 14),
        hourlyUsage: hourlyUsageHistory(db, 24),
        providers: listProviders(db).length,
        models: listModels(db).length,
        keys: listApiKeys(db).filter((k) => k.enabled).length,
      };

    case "usage":
      return {
        today: {
          total: totalUsageToday(db),
          keys: listUsageToday(db),
        },
        history: totalUsageHistory(db, 14),
      };

    case "usage:breakdown":
      return { rows: fullBreakdownToday(db) };

    case "request-logs": {
      const opts: ListOpts = {
        limit: typeof params?.limit === "number" ? params.limit : 100,
        offset: typeof params?.offset === "number" ? params.offset : 0,
        modelId: typeof params?.model === "string" ? params.model : undefined,
        statusError: params?.error === "1" || params?.error === true,
      };
      return listRequestLogs(db, opts);
    }

    case "providers":
      return listProviders(db);

    case "models":
      return listModels(db);

    case "keys":
      return listApiKeys(db);

    case "users":
      return listUsers(db);

    case "settings": {
      const s = getSettings(db);
      return {
        modelPrefix: s.modelPrefix,
        exposePrefix: s.exposePrefix,
        exposeExempt: s.exposeExempt,
        allowUnknown: s.allowUnknown,
        defaultMaxOutputTokens: s.defaultMaxOutputTokens,
        ssePingInterval: s.ssePingInterval,
        requestLogRetentionDays: s.requestLogRetentionDays,
        debugLogging: s.debugLogging,
        webToolsEnabled: s.webToolsEnabled,
        webToolsProvider: s.webToolsProvider,
        webProviderBaseUrl: s.webProviderBaseUrl,
        webProviderApiKey: s.webProviderApiKey,
      };
    }
  }
}
