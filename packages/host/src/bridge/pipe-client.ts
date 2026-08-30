import net, { type Socket } from "node:net";
import {
  BridgeAuthenticator,
  createBridgeAuthInit,
  createBridgeAuthProof,
  findInProcessBridgeAuthKey,
  isBridgeAuthReady,
  loadExistingBridgeAuthKey,
  parseBridgeAuthChallenge,
} from "./bridge-auth.js";
import { encodeFrame, FrameDecoder } from "./pipe-server.js";

const AUTH_HANDSHAKE_TIMEOUT_MS = 15_000;
const PIPE_CONNECT_RETRY_TIMEOUT_MS = 2_000;
const PIPE_CONNECT_RETRY_DELAY_MS = 25;
const TRANSIENT_WINDOWS_PIPE_ERRORS = new Set(["ENOENT", "ECONNREFUSED", "EBUSY"]);

export interface PipeClient {
  send: (message: unknown) => void;
  onMessage: (handler: (message: unknown) => void) => void;
  onError: (handler: (error: Error) => void) => void;
  onClose?: (handler: () => void) => void;
  close: () => Promise<void>;
}

export interface ConnectPipeClientOptions {
  authKey?: Buffer;
  appDataDir?: string;
  allowDevelopmentSecretFallback?: boolean;
}

async function resolveClientAuthKey(
  pipePath: string,
  options: ConnectPipeClientOptions,
): Promise<Buffer> {
  const key =
    options.authKey ??
    findInProcessBridgeAuthKey(pipePath) ??
    (await loadExistingBridgeAuthKey(options.appDataDir, {
      allowDevelopmentFallback: options.allowDevelopmentSecretFallback === true,
    }));
  if (!key || key.length !== 32) {
    throw new Error("bridge HMAC key is unavailable; refusing unauthenticated pipe connection");
  }
  return key;
}

function openPipeSocket(pipePath: string): Promise<Socket> {
  const retryDeadline = Date.now() + PIPE_CONNECT_RETRY_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const socket = net.createConnection(pipePath);
      const onConnect = (): void => {
        socket.removeListener("error", onError);
        resolve(socket);
      };
      const onError = (error: NodeJS.ErrnoException): void => {
        socket.removeListener("connect", onConnect);
        socket.destroy();
        if (
          process.platform === "win32" &&
          TRANSIENT_WINDOWS_PIPE_ERRORS.has(error.code ?? "") &&
          Date.now() < retryDeadline
        ) {
          setTimeout(attempt, PIPE_CONNECT_RETRY_DELAY_MS);
          return;
        }
        reject(error);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    };

    attempt();
  });
}

export async function connectPipeClient(
  pipePath: string,
  options: ConnectPipeClientOptions = {},
): Promise<PipeClient> {
  const authKey = await resolveClientAuthKey(pipePath, options);
  const socket = await openPipeSocket(pipePath);
  const decoder = new FrameDecoder();
  let authenticator: BridgeAuthenticator | undefined;
  const handlers: Array<(message: unknown) => void> = [];
  const errorHandlers: Array<(error: Error) => void> = [];
  let resolveHandshake: (() => void) | undefined;
  let rejectHandshake: ((error: Error) => void) | undefined;
  let handshakeSettled = false;
  const handshake = new Promise<void>((resolve, reject) => {
    resolveHandshake = resolve;
    rejectHandshake = reject;
  });
  // A socket can fail before the connect promise below completes. Mark this
  // second promise as observed immediately so that the same early error cannot
  // become an unhandled rejection before we reach the handshake await.
  void handshake.catch(() => undefined);

  function failHandshake(error: Error): void {
    if (handshakeSettled) return;
    handshakeSettled = true;
    rejectHandshake?.(error);
  }
  const closeHandlers: Array<() => void> = [];
  let closed = false;

  // Keep a permanent listener so an authenticated-framing failure closes the
  // transport without becoming an uncaught EventEmitter error when a caller
  // chooses not to observe diagnostics.
  socket.on("error", (error) => {
    failHandshake(error);
    for (const handler of errorHandlers) {
      handler(error);
    }
  });
  socket.once("close", () => {
    failHandshake(new Error("bridge connection closed before authentication completed"));
  });
  socket.on("close", () => {
    closed = true;
    for (const handler of closeHandlers) {
      handler();
    }
  });

  socket.on("data", (chunk: Buffer) => {
    try {
      const frames = decoder.push(chunk);
      for (const frame of frames) {
        if (!authenticator) {
          const session = parseBridgeAuthChallenge(frame);
          if (!session) {
            socket.destroy(new Error("bridge returned an invalid authentication challenge"));
            return;
          }
          authenticator = new BridgeAuthenticator(authKey, {
            session,
            signDirection: "client-to-server",
            verifyDirection: "server-to-client",
          });
          socket.write(encodeFrame(authenticator.sign(createBridgeAuthProof())));
          continue;
        }
        const verification = authenticator.verify(frame);
        if (!verification.ok) {
          socket.destroy(new Error(verification.reason ?? "bridge response authentication failed"));
          return;
        }
        if (!handshakeSettled) {
          if (!isBridgeAuthReady(verification.message)) {
            socket.destroy(new Error("bridge returned an invalid authentication proof"));
            return;
          }
          handshakeSettled = true;
          resolveHandshake?.();
          continue;
        }
        for (const handler of handlers) {
          handler(verification.message);
        }
      }
    } catch (error) {
      socket.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });

  socket.write(encodeFrame(createBridgeAuthInit()));

  const handshakeTimer = setTimeout(() => {
    const error = new Error("bridge authentication challenge timed out");
    failHandshake(error);
    socket.destroy(error);
  }, AUTH_HANDSHAKE_TIMEOUT_MS);
  handshakeTimer.unref();
  try {
    await handshake;
  } finally {
    clearTimeout(handshakeTimer);
  }

  return {
    send: (message: unknown) => {
      if (!authenticator) {
        throw new Error("bridge authentication is not initialized");
      }
      socket.write(encodeFrame(authenticator.sign(message)));
    },
    onMessage: (handler) => {
      handlers.push(handler);
    },
    onError: (handler) => {
      errorHandlers.push(handler);
    },
    onClose: (handler) => {
      if (closed) {
        queueMicrotask(handler);
        return;
      }
      closeHandlers.push(handler);
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
