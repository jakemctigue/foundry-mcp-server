import { WebSocketServer, type WebSocket } from "ws";
import {
  CompanionHelloMessageSchema,
  CompanionResponseMessageSchema,
  CompanionWireMessageSchema,
  type CompanionHelloMessage,
  type CompanionRequestMessage,
  type JsonValue,
} from "@foundry-mcp/protocol";

import type Database from "better-sqlite3";
import { HostEventStream } from "../intelligence/event-stream.js";
import type { EventCaptureOptions } from "../intelligence/event-ledger.js";
import { assertAllowedWebSocketOrigin } from "./websocket-origin.js";

export interface CompanionConnectionInfo extends CompanionHelloMessage {
  status: "connected";
  lastSeenAt: string;
}
export interface HostCompanionServerOptions {
  port?: number;
  host?: string;
  allowedOrigins: readonly string[];
  db: Database.Database;
  capture?: EventCaptureOptions;
  requestTimeoutMs?: number;
}

export interface HostCompanionServer {
  address(): { host: string; port: number; endpoint: string };
  listConnections(): CompanionConnectionInfo[];
  request(
    connectionId: string,
    method: string,
    params?: Record<string, JsonValue>,
    requestId?: string,
  ): Promise<JsonValue>;
  close(): Promise<void>;
}

interface PendingRequest {
  message: CompanionRequestMessage;
  promise: Promise<JsonValue>;
  resolve(value: JsonValue): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface LiveConnection {
  socket: WebSocket;
  info: CompanionConnectionInfo;
}

let requestCounter = 0;

/** Real loopback WebSocket endpoint for the browser companion. */
export async function startHostCompanionServer(
  options: HostCompanionServerOptions,
): Promise<HostCompanionServer> {
  const host = options.host ?? "127.0.0.1";
  const eventStream = new HostEventStream(options.db, options.capture);
  const connections = new Map<string, LiveConnection>();
  const pending = new Map<string, PendingRequest>();
  const completed = new Map<string, JsonValue>();
  const wss = new WebSocketServer({
    port: options.port ?? 0,
    host,
    verifyClient: (info: { origin: string }) => {
      try {
        assertAllowedWebSocketOrigin(info.origin, options.allowedOrigins);
        return true;
      } catch {
        return false;
      }
    },
  });

  const send = (socket: WebSocket, value: unknown): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(value));
  };

  wss.on("connection", (socket) => {
    let connectionId: string | undefined;
    socket.on("message", (data) => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(data.toString()) as unknown;
      } catch {
        socket.close(1003, "invalid JSON");
        return;
      }
      if (!connectionId) {
        const hello = CompanionHelloMessageSchema.safeParse(decoded);
        if (!hello.success) {
          socket.close(1008, "valid companion hello required");
          return;
        }
        connectionId = hello.data.connectionId;
        const prior = connections.get(connectionId);
        if (prior && prior.socket !== socket) prior.socket.close(1012, "companion reconnected");
        const info: CompanionConnectionInfo = {
          ...hello.data,
          status: "connected",
          lastSeenAt: new Date().toISOString(),
        };
        connections.set(connectionId, { socket, info });
        send(socket, eventStream.resume(connectionId));
        for (const request of pending.values()) {
          if ((request.message.params["connectionId"] as unknown) === connectionId) {
            send(socket, request.message);
          }
        }
        return;
      }

      const message = CompanionWireMessageSchema.safeParse(decoded);
      if (!message.success) {
        socket.close(1003, "invalid companion message");
        return;
      }
      const live = connections.get(connectionId);
      if (live) live.info.lastSeenAt = new Date().toISOString();
      if (message.data.type === "event") {
        if (message.data.connectionId !== connectionId) {
          socket.close(1008, "connectionId mismatch");
          return;
        }
        send(socket, eventStream.ingest(message.data));
        return;
      }
      if (message.data.type !== "response") return;
      const response = CompanionResponseMessageSchema.parse(message.data);
      const request = pending.get(response.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(response.id);
      const result: JsonValue = response.ok
        ? (response.value as JsonValue)
        : ({ ok: false, error: response.error as JsonValue } as JsonValue);
      completed.set(response.id, result);
      while (completed.size > 500) completed.delete(completed.keys().next().value as string);
      request.resolve(result);
    });
    socket.on("close", () => {
      if (connectionId && connections.get(connectionId)?.socket === socket) {
        connections.delete(connectionId);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });

  return {
    address: () => {
      const address = wss.address();
      if (typeof address === "string" || address === null)
        throw new Error("companion WebSocket server address is unavailable");
      return { host, port: address.port, endpoint: `ws://${host}:${address.port.toString()}` };
    },
    listConnections: () =>
      [...connections.values()].map(({ info }) => ({ ...info })).sort((left, right) =>
        left.connectionId.localeCompare(right.connectionId),
      ),
    request: (connectionId, method, params = {}, requestId) => {
      const id = requestId ?? `host-${Date.now().toString(36)}-${(++requestCounter).toString(36)}`;
      const priorResult = completed.get(id);
      if (priorResult !== undefined) return Promise.resolve(priorResult);
      const priorPending = pending.get(id);
      if (priorPending) return priorPending.promise;
      let resolveRequest: (value: JsonValue) => void = () => undefined;
      let rejectRequest: (error: Error) => void = () => undefined;
      const promise = new Promise<JsonValue>((resolve, reject) => {
        resolveRequest = resolve;
        rejectRequest = reject;
      });
      const message: CompanionRequestMessage = {
        type: "request",
        id,
        method,
        params: { ...params, connectionId },
      };
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error(`companion request timed out: ${method}`));
      }, options.requestTimeoutMs ?? 30_000);
      timer.unref?.();
      pending.set(id, {
        message,
        promise,
        resolve: resolveRequest,
        reject: rejectRequest,
        timer,
      });
      const live = connections.get(connectionId);
      if (live) send(live.socket, message);
      return promise;
    },
    close: async () => {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("companion server closed"));
      }
      pending.clear();
      for (const { socket } of connections.values()) socket.terminate();
      connections.clear();
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
