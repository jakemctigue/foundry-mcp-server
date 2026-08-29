import net from "node:net";
import { encodeFrame, FrameDecoder } from "./pipe-server.js";

export interface PipeClient {
  send: (message: unknown) => void;
  onMessage: (handler: (message: unknown) => void) => void;
  close: () => Promise<void>;
}

export async function connectPipeClient(pipePath: string): Promise<PipeClient> {
  const socket = net.createConnection(pipePath);
  const decoder = new FrameDecoder();
  const handlers: Array<(message: unknown) => void> = [];

  socket.on("data", (chunk: Buffer) => {
    const messages = decoder.push(chunk);
    for (const message of messages) {
      for (const handler of handlers) {
        handler(message);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve();
    });
    socket.once("error", reject);
  });

  return {
    send: (message: unknown) => {
      socket.write(encodeFrame(message));
    },
    onMessage: (handler) => {
      handlers.push(handler);
    },
    close: () =>
      new Promise<void>((resolve) => {
        socket.end(() => {
          resolve();
        });
      }),
  };
}
