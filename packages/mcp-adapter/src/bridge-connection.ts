import { randomUUID } from "node:crypto";

import { connectPipeClient, type PipeClient } from "@foundry-mcp/host";
import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeProgressMessageSchema,
  ErrorEnvelope,
  MAX_OPERATION_DURATION_MS,
  makeError,
  type OperationProgress,
} from "@foundry-mcp/protocol";

export interface BridgeRequestOptions {
  signal?: AbortSignal;
  deadline?: number;
  correlationId?: string;
  onProgress?: (progress: OperationProgress) => void | Promise<void>;
}

export class BridgeRequestError extends Error {
  constructor(readonly envelope: ErrorEnvelope) {
    super(envelope.message);
    this.name = "BridgeRequestError";
  }
}

export interface BridgeConnection {
  request: (
    method: string,
    params?: Record<string, unknown>,
    options?: BridgeRequestOptions,
  ) => Promise<unknown>;
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
  correlationId: string;
  onProgress?: ((progress: OperationProgress) => void | Promise<void>) | undefined;
  progressUpdates: number;
  removeAbortListener?: (() => void) | undefined;
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
      request.removeAbortListener?.();
      request.reject(error);
    }
    pending.clear();
  };

  client.onMessage((message) => {
    const progress = BridgeProgressMessageSchema.safeParse(message);
    if (progress.success) {
      const request = pending.get(progress.data.id);
      if (!request || !request.onProgress || request.progressUpdates >= 1_000) return;
      request.progressUpdates += 1;
      void Promise.resolve(request.onProgress(progress.data.progress)).catch(() => undefined);
      return;
    }
    const response = message as { id?: string; result?: unknown; error?: unknown };
    if (!response.id) return;
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timer);
    request.removeAbortListener?.();
    if (response.error !== undefined) {
      const parsed = ErrorEnvelope.safeParse(response.error);
      request.reject(
        new BridgeRequestError(
          parsed.success
            ? parsed.data
            : makeError("FOUNDRY_ERROR", `bridge request ${response.id} failed`),
        ),
      );
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
    request: (method, params, requestOptions = {}) =>
      new Promise((resolve, reject) => {
        if (closed) {
          reject(new Error("bridge transport is closed"));
          return;
        }
        const now = Date.now();
        const id = `req-${randomUUID()}`;
        const correlationId = requestOptions.correlationId ?? `bridge-${randomUUID()}`;
        const maximumDeadline = now + Math.min(requestTimeoutMs, MAX_OPERATION_DURATION_MS);
        const deadline = Math.min(requestOptions.deadline ?? maximumDeadline, maximumDeadline);
        const abortCode = requestOptions.signal?.aborted
          ? "CANCELLED"
          : deadline <= now
            ? "TIMEOUT"
            : undefined;
        if (abortCode) {
          reject(
            new BridgeRequestError(
              makeError(
                abortCode,
                abortCode === "TIMEOUT"
                  ? "Bridge request deadline elapsed before dispatch"
                  : "Bridge request was cancelled before dispatch",
                false,
                { correlationId },
              ),
            ),
          );
          return;
        }
        const cancel = (reason: "cancelled" | "timeout"): void => {
          const pendingRequest = pending.get(id);
          if (!pendingRequest) return;
          pending.delete(id);
          clearTimeout(pendingRequest.timer);
          pendingRequest.removeAbortListener?.();
          try {
            client.send({ type: "request.cancel", id, correlationId, reason });
          } catch {
            // The local rejection below is authoritative even if transport teardown won the race.
          }
          pendingRequest.reject(
            new BridgeRequestError(
              makeError(
                reason === "timeout" ? "TIMEOUT" : "CANCELLED",
                reason === "timeout"
                  ? `bridge request ${method} timed out after ${Math.max(1, deadline - now).toString()}ms`
                  : `Bridge request ${method} was cancelled`,
                false,
                { correlationId },
              ),
            ),
          );
        };
        const timer = setTimeout(
          () => {
            cancel("timeout");
          },
          Math.max(1, deadline - now),
        );
        timer.unref?.();
        let removeAbortListener: (() => void) | undefined;
        if (requestOptions.signal) {
          const onAbort = (): void => cancel("cancelled");
          requestOptions.signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => requestOptions.signal?.removeEventListener("abort", onAbort);
        }
        pending.set(id, {
          resolve,
          reject,
          timer,
          correlationId,
          onProgress: requestOptions.onProgress,
          progressUpdates: 0,
          removeAbortListener,
        });
        try {
          client.send({
            type: "request",
            id,
            method,
            params: params ?? {},
            control: {
              deadline,
              correlationId,
              progress: requestOptions.onProgress !== undefined,
            },
          });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          removeAbortListener?.();
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
    request: (method, _params, options) => {
      if (options?.signal?.aborted) {
        return Promise.reject(
          new BridgeRequestError(makeError("CANCELLED", "Bridge request was cancelled")),
        );
      }
      if (options?.deadline !== undefined && options.deadline <= Date.now()) {
        return Promise.reject(
          new BridgeRequestError(makeError("TIMEOUT", "Bridge request deadline elapsed")),
        );
      }
      if (method === "connections.list") {
        return Promise.resolve({ connections: [] });
      }
      return Promise.resolve(null);
    },
    close: () => Promise.resolve(),
  };
}
