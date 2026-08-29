import { WebSocketServer, type WebSocket } from "ws";
import { EventPublishMessageSchema } from "@foundry-mcp/protocol";

import type { HostEventStream } from "../intelligence/event-stream.js";
import { assertAllowedWebSocketOrigin } from "../bridge/websocket-origin.js";

export interface FakeFoundryWsServer {
  address: () => { port: number };
  onConnection: (handler: (socket: WebSocket) => void) => void;
  close: () => Promise<void>;
}

export interface FakeFoundryWsServerOptions {
  port?: number;
  allowedOrigins?: readonly string[];
  eventStream?: HostEventStream;
  connectionId?: string;
}

/** Simulates the Foundry module's WebSocket bridge endpoint for tests. */
export async function startFakeFoundryWsServer(
  portOrOptions: number | FakeFoundryWsServerOptions = 0,
): Promise<FakeFoundryWsServer> {
  const options = typeof portOrOptions === "number" ? { port: portOrOptions } : portOrOptions;
  const wss = new WebSocketServer({
    port: options.port ?? 0,
    host: "127.0.0.1",
    ...(options.allowedOrigins
      ? {
          verifyClient: (info: { origin: string }) => {
            try {
              assertAllowedWebSocketOrigin(info.origin, options.allowedOrigins as readonly string[]);
              return true;
            } catch {
              return false;
            }
          },
        }
      : {}),
  });
  const handlers: Array<(socket: WebSocket) => void> = [];

  wss.on("connection", (socket) => {
    if (options.eventStream && options.connectionId) {
      socket.send(JSON.stringify(options.eventStream.resume(options.connectionId)));
      socket.on("message", (data) => {
        try {
          const parsed = EventPublishMessageSchema.parse(JSON.parse(data.toString()) as unknown);
          socket.send(JSON.stringify(options.eventStream?.ingest(parsed)));
        } catch {
          socket.close(1003, "invalid event message");
        }
      });
    }
    for (const handler of handlers) {
      handler(socket);
    }
  });

  await new Promise<void>((resolve) => {
    wss.once("listening", resolve);
  });

  return {
    address: () => {
      const addr = wss.address();
      if (typeof addr === "string" || addr === null) {
        throw new Error("expected AddressInfo from ws server");
      }
      return { port: addr.port };
    },
    onConnection: (handler) => {
      handlers.push(handler);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        wss.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  };
}
