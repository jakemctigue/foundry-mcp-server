import { connectPipeClient, type PipeClient } from "@foundry-mcp/host";
import { PROTOCOL_VERSION } from "@foundry-mcp/protocol";

export interface BridgeConnection {
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  close: () => Promise<void>;
}

export interface InitializeResult {
  protocolVersion: string;
}

/** Performs the bridge-level (daemon <-> adapter) initialize handshake. */
export async function negotiateProtocolVersion(
  bridge: BridgeConnection,
): Promise<InitializeResult> {
  const result = (await bridge.request("initialize")) as InitializeResult;
  if (result.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `bridge protocol version mismatch: expected ${PROTOCOL_VERSION}, got ${result.protocolVersion}`,
    );
  }
  return result;
}

let requestCounter = 0;

export async function connectToDaemon(pipePath: string): Promise<BridgeConnection> {
  const client: PipeClient = await connectPipeClient(pipePath);
  const pending = new Map<string, (result: unknown) => void>();

  client.onMessage((message) => {
    const response = message as { id?: string; result?: unknown };
    if (response.id && pending.has(response.id)) {
      pending.get(response.id)?.(response.result);
      pending.delete(response.id);
    }
  });

  return {
    request: (method, params) =>
      new Promise((resolve) => {
        const id = `req-${(requestCounter++).toString()}`;
        pending.set(id, resolve);
        client.send({ id, method, params: params ?? {} });
      }),
    close: () => client.close(),
  };
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
