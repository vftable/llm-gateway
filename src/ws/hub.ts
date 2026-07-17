// WebSocket hub — manages connected clients, subscriptions, push timers,
// and mutation broadcasts. All DB queries are synchronous (better-sqlite3),
// so push handlers run on the event loop without async overhead.

import type { WebSocket } from "ws";
import type { Database as DB } from "better-sqlite3";
import type { Logger } from "../logger";
import { type WsTopic, PUSH_INTERVALS, WS_TOPICS } from "./schema";
import type { WsServerMessage, WsRequest } from "./schema";
import { fetchTopic } from "./topics";

interface WsClient {
  ws: WebSocket;
  subs: Set<WsTopic>;
  alive: boolean;
  params: Map<WsTopic, Record<string, string | number | boolean>>;
}

const HEARTBEAT_INTERVAL = 30_000;

export class WsHub {
  private clients = new Set<WsClient>();
  private pushTimers = new Map<WsTopic, ReturnType<typeof setInterval>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: DB,
    private readonly logger: Logger,
  ) {}

  addClient(ws: WebSocket): WsClient {
    const client: WsClient = {
      ws,
      subs: new Set(),
      alive: true,
      params: new Map(),
    };
    this.clients.add(client);
    this.logger.info("ws_connect", { clients: this.clients.size });
    return client;
  }

  removeClient(client: WsClient): void {
    this.clients.delete(client);
    for (const topic of client.subs) {
      this.checkTimer(topic);
    }
    this.logger.info("ws_disconnect", { clients: this.clients.size });
  }

  subscribe(
    client: WsClient,
    topic: WsTopic,
    params?: Record<string, string | number | boolean>,
  ): void {
    if (!WS_TOPICS.includes(topic)) {
      this.send(client, {
        type: "error",
        message: `unknown topic: ${topic}`,
      });
      return;
    }
    client.subs.add(topic);
    if (params) client.params.set(topic, params);
    else client.params.delete(topic);

    this.pushToClient(client, topic);
    this.ensureTimer(topic);
  }

  unsubscribe(client: WsClient, topic: WsTopic): void {
    client.subs.delete(topic);
    client.params.delete(topic);
    this.checkTimer(topic);
  }

  handleRequest(client: WsClient, msg: WsRequest): void {
    try {
      const topic = msg.endpoint as WsTopic;
      if (!WS_TOPICS.includes(topic)) {
        this.send(client, {
          type: "response",
          id: msg.id,
          error: { message: `unknown endpoint: ${msg.endpoint}` },
        });
        return;
      }
      const data = fetchTopic(this.db, topic, msg.params);
      this.send(client, { type: "response", id: msg.id, data });
    } catch (err) {
      this.send(client, {
        type: "response",
        id: msg.id,
        error: { message: (err as Error).message },
      });
    }
  }

  broadcast(topics: WsTopic[], source: string): void {
    const invalidate: WsServerMessage = {
      type: "invalidate",
      topics,
      source,
    };
    for (const client of this.clients) {
      const affected = topics.some((t) => client.subs.has(t));
      if (!affected) continue;
      this.send(client, invalidate);
      for (const t of topics) {
        if (client.subs.has(t)) this.pushToClient(client, t);
      }
    }
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        if (!client.alive) {
          this.logger.info("ws_heartbeat_timeout");
          client.ws.terminate();
          this.removeClient(client);
          continue;
        }
        client.alive = false;
        this.send(client, { type: "ping" });
      }
    }, HEARTBEAT_INTERVAL);
    unref(this.heartbeatTimer);
  }

  markAlive(client: WsClient): void {
    client.alive = true;
  }

  shutdown(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const [, timer] of this.pushTimers) clearInterval(timer);
    this.pushTimers.clear();
    for (const client of this.clients) {
      try {
        client.ws.close(1001, "server shutting down");
      } catch {
        /* noop */
      }
    }
    this.clients.clear();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  // ── internals ──────────────────────────────────────────────────────

  private pushToClient(client: WsClient, topic: WsTopic): void {
    try {
      const data = fetchTopic(this.db, topic, client.params.get(topic));
      this.send(client, { type: "push", topic, data });
    } catch (err) {
      this.logger.warn("ws_push_error", {
        topic,
        err: (err as Error).message,
      });
    }
  }

  private pushToAll(topic: WsTopic): void {
    for (const client of this.clients) {
      if (client.subs.has(topic)) this.pushToClient(client, topic);
    }
  }

  private ensureTimer(topic: WsTopic): void {
    const interval = PUSH_INTERVALS[topic];
    if (!interval || this.pushTimers.has(topic)) return;
    const timer = setInterval(() => this.pushToAll(topic), interval);
    unref(timer);
    this.pushTimers.set(topic, timer);
  }

  private checkTimer(topic: WsTopic): void {
    const anySubscribed = [...this.clients].some((c) => c.subs.has(topic));
    if (anySubscribed) return;
    const timer = this.pushTimers.get(topic);
    if (timer) {
      clearInterval(timer);
      this.pushTimers.delete(topic);
    }
  }

  private send(client: WsClient, msg: WsServerMessage): void {
    if (client.ws.readyState !== client.ws.OPEN) return;
    try {
      client.ws.send(JSON.stringify(msg));
    } catch {
      /* noop */
    }
  }
}

function unref(timer: ReturnType<typeof setInterval>): void {
  if (typeof (timer as { unref?: () => void }).unref === "function")
    (timer as { unref: () => void }).unref();
}
