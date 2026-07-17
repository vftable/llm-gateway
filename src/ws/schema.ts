// WebSocket message schema — the single source of truth for the typed
// protocol between the admin UI and the gateway server.

export type WsTopic =
  | "overview"
  | "usage"
  | "usage:breakdown"
  | "request-logs"
  | "providers"
  | "models"
  | "keys"
  | "users"
  | "settings";

export const WS_TOPICS: readonly WsTopic[] = [
  "overview",
  "usage",
  "usage:breakdown",
  "request-logs",
  "providers",
  "models",
  "keys",
  "users",
  "settings",
];

// ── Client → Server ─────────────────────────────────────────────────

export interface WsSubscribe {
  type: "subscribe";
  topic: WsTopic;
  params?: Record<string, string | number | boolean>;
}

export interface WsUnsubscribe {
  type: "unsubscribe";
  topic: WsTopic;
}

export interface WsRequest {
  type: "request";
  id: string;
  endpoint: string;
  params?: Record<string, string | number | boolean>;
}

export interface WsPong {
  type: "pong";
}

export type WsClientMessage = WsSubscribe | WsUnsubscribe | WsRequest | WsPong;

// ── Server → Client ─────────────────────────────────────────────────

export interface WsPush {
  type: "push";
  topic: WsTopic;
  data: unknown;
}

export interface WsResponse {
  type: "response";
  id: string;
  data?: unknown;
  error?: { message: string; code?: number };
}

export interface WsPing {
  type: "ping";
}

export interface WsInvalidate {
  type: "invalidate";
  topics: WsTopic[];
  source?: string;
}

export interface WsError {
  type: "error";
  message: string;
  code?: number;
}

export type WsServerMessage =
  WsPush | WsResponse | WsPing | WsInvalidate | WsError;

// Push intervals for auto-refresh topics (ms). Topics not listed here
// push only on mutation (no timer).
export const PUSH_INTERVALS: Partial<Record<WsTopic, number>> = {
  overview: 15_000,
  "request-logs": 10_000,
  usage: 20_000,
  "usage:breakdown": 20_000,
};
