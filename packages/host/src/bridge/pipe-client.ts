import net from "node:net";
import {
  BridgeAuthenticator,
  findInProcessBridgeAuthKey,
  loadExistingBridgeAuthKey,
} from "./bridge-auth.js";
import { encodeFrame, FrameDecoder } from "./pipe-server.js";

export interface PipeClient {
  send: (message: unknown) => void;
  onMessage: (handler: (message: unknown) => void) => void;
  onError: (handler: (error: Error) => void) => void;
  close: () => Promise<void>;
}

export interface ConnectPipeClientOptions {
  authKey?: Buffer;
  appDataDir?: string;
}

async function resolveClientAuthKey(
  pipePath: string,
  options: ConnectPipeClientOptions,
): Promise<Buffer> {
  const key =
    options.authKey ??
    findInProcessBridgeAuthKey(pipePath) ??
    (await loadExistingBridgeAuthKey(options.appDataDir));
  if (!key || key.length !== 32) {
    throw new Error("bridge HMAC key is unavailable; refusing unauthenticated pipe connection");
  }
  return key;
}

export async function connectPipeClient(
  pipePath: string,
  options: ConnectPipeClientOptions = {},
): Promise<PipeClient> {
  const authKey = await resolveClientAuthKey(pipePath, options);
  const socket = net.createConnection(pipePath);
  const decoder = new FrameDecoder();
  const authenticator = new BridgeAuthenticator(authKey);
  const handlers: Array<(message: unknown) => void> = [];
  const errorHandlers: Array<(error: Error) => void> = [];

  // Keep a permanent listener so an authenticated-framing failure closes the
  // transport without becoming an uncaught EventEmitter error when a caller
  // chooses not to observe diagnostics.
  socket.on("error", (error) => {
    for (const handler of errorHandlers) {
      handler(error);
    }
  });

  socket.on("data", (chunk: Buffer) => {
    try {
      const frames = decoder.push(chunk);
      for (const frame of frames) {
        const verification = authenticator.verify(frame);
        if (!verification.ok) {
          socket.destroy(new Error(verification.reason ?? "bridge response authentication failed"));
          return;
        }
        for (const handler of handlers) {
          handler(verification.message);
        }
      }
    } catch (error) {
      socket.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => {
      socket.removeListener("error", reject);
      resolve();
    });
    socket.once("error", reject);
  });

  return {
    send: (message: unknown) => {
      socket.write(encodeFrame(authenticator.sign(message)));
    },
    onMessage: (handler) => {
      handlers.push(handler);
    },
    onError: (handler) => {
      errorHandlers.push(handler);
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (socket.destroyed) {
          resolve();
          return;
        }
        socket.end(() => resolve());
      }),
  };
}
