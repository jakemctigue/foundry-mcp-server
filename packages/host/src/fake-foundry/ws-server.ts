import { WebSocketServer, type WebSocket } from "ws";

export interface FakeFoundryWsServer {
  address: () => { port: number };
  onConnection: (handler: (socket: WebSocket) => void) => void;
  close: () => Promise<void>;
}

/** Simulates the Foundry module's WebSocket bridge endpoint for tests. */
export async function startFakeFoundryWsServer(port = 0): Promise<FakeFoundryWsServer> {
  const wss = new WebSocketServer({ port, host: "127.0.0.1" });
  const handlers: Array<(socket: WebSocket) => void> = [];

  wss.on("connection", (socket) => {
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
