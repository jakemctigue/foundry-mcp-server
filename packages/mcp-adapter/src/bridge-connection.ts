import { connectPipeClient, type PipeClient } from "@foundry-mcp/host";
import { BRIDGE_PROTOCOL_VERSION } from "@foundry-mcp/protocol";

export interface BridgeConnection {
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  close: () => Promise<void>;
}

export interface InitializeResult {
  protocolVersion: string;
}

const DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_NEGOTIATION_TIMEOUT_MS = 5_000;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ConnectToDaemonOptions {
  connectPipeClient?: (pipePath: string) => Promise<PipeClient>;
  requestTimeoutMs?: number;
}

function validatedTimeout(value: number | undefined, fallback: number, label: string): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return timeout;
}

async function promiseWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs.toString()}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Performs the bridge-level (daemon <-> adapter) initialize handshake. */
export async function negotiateProtocolVersion(
  bridge: BridgeConnection,
): Promise<InitializeResult> {
  const result = (await bridge.request("initialize")) as InitializeResult;
  if (result.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    throw new Error(
      `bridge protocol version mismatch: expected ${BRIDGE_PROTOCOL_VERSION}, got ${result.protocolVersion}`,
    );
  }
  return result;
}

let requestCounter = 0;

export async function connectToDaemon(
  pipePath: string,
  options: ConnectToDaemonOptions = {},
): Promise<BridgeConnection> {
  const requestTimeoutMs = validatedTimeout(
    options.requestTimeoutMs,
    DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS,
    "bridge request timeout",
  );
  const client: PipeClient = await (options.connectPipeClient ?? connectPipeClient)(pipePath);
  const pending = new Map<string, PendingRequest>();
  let closed = false;

  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };

  client.onMessage((message) => {
    const response = message as { id?: string; result?: unknown; error?: unknown };
    if (!response.id) return;
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.error !== undefined) {
      request.reject(new Error(`bridge request ${response.id} failed`));
      return;
    }
    request.resolve(response.result);
  });
  client.onError((error) => {
    closed = true;
    rejectPending(error);
  });
  client.onClose?.(() => {
    closed = true;
    rejectPending(new Error("bridge transport closed before the request completed"));
  });

  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        if (closed) {
          reject(new Error("bridge transport is closed"));
          return;
        }
        const id = `req-${(requestCounter++).toString()}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(
              `bridge request ${method} timed out after ${requestTimeoutMs.toString()}ms`,
            ),
          );
        }, requestTimeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        try {
          client.send({ id, method, params: params ?? {} });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }),
    close: async () => {
      closed = true;
      rejectPending(new Error("bridge connection closed"));
      await client.close();
    },
  };
}

export interface NegotiatedBridgeDependencies {
  connect?: (pipePath: string) => Promise<BridgeConnection>;
  negotiate?: (bridge: BridgeConnection) => Promise<InitializeResult>;
  negotiateTimeoutMs?: number;
}

/** Opens and negotiates a real daemon bridge, closing it on any handshake failure. */
export async function connectNegotiatedBridge(
  pipePath: string,
  dependencies: NegotiatedBridgeDependencies = {},
): Promise<BridgeConnection> {
  const bridge = await (dependencies.connect ?? connectToDaemon)(pipePath);
  try {
    const timeoutMs = validatedTimeout(
      dependencies.negotiateTimeoutMs,
      DEFAULT_NEGOTIATION_TIMEOUT_MS,
      "bridge negotiation timeout",
    );
    await promiseWithTimeout(
      (dependencies.negotiate ?? negotiateProtocolVersion)(bridge),
      timeoutMs,
      "bridge negotiation",
    );
    return bridge;
  } catch (error) {
    try {
      await bridge.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "Bridge negotiation failed and the connection could not be closed",
        { cause: closeError },
      );
    }
    throw error;
  }
}

/** In-memory stub used when no real daemon connection is configured yet. */
export function createStubBridgeConnection(): BridgeConnection {
  return {
    request: (method) => {
      if (method === "connections.list") {
        return Promise.resolve({ connections: [] });
      }
      return Promise.resolve(null);
    },
    close: () => Promise.resolve(),
  };
}
