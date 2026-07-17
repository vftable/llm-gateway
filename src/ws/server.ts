// WebSocket server — attaches to the existing http.Server, handles upgrade
// auth via the same admin token, and routes messages through the hub.

import { WebSocketServer, type WebSocket } from "ws";
import type { Server as HttpServer } from "http";
import type { Database as DB } from "better-sqlite3";
import type { Logger } from "../logger";
import { verifyToken } from "../auth/admin-auth";
import { WsHub } from "./hub";
import type { WsClientMessage } from "./schema";

export function createWsServer(
  httpServer: HttpServer,
  db: DB,
  logger: Logger,
  adminSecret: string,
): WsHub {
  const wss = new WebSocketServer({ noServer: true });
  const hub = new WsHub(db, logger);

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    if (url.pathname !== "/ws") return;

    const token =
      url.searchParams.get("token") ??
      (req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : "");

    if (!verifyToken(token, adminSecret)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    const client = hub.addClient(ws);

    ws.on("message", (raw) => {
      let msg: WsClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as WsClientMessage;
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "invalid JSON" }));
        return;
      }

      switch (msg.type) {
        case "subscribe":
          hub.subscribe(client, msg.topic, msg.params);
          break;
        case "unsubscribe":
          hub.unsubscribe(client, msg.topic);
          break;
        case "request":
          hub.handleRequest(client, msg);
          break;
        case "pong":
          hub.markAlive(client);
          break;
        default:
          ws.send(
            JSON.stringify({ type: "error", message: "unknown message type" }),
          );
      }
    });

    ws.on("close", () => hub.removeClient(client));
    ws.on("error", () => {
      try {
        ws.terminate();
      } catch {
        /* noop */
      }
      hub.removeClient(client);
    });
  });

  hub.startHeartbeat();
  logger.info("ws_server_ready", { path: "/ws" });
  return hub;
}
