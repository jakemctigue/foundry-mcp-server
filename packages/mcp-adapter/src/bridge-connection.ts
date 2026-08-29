import { connectPipeClient, type PipeClient } from "@foundry-mcp/host";
import { BRIDGE_PROTOCOL_VERSION } from "@foundry-mcp/protocol";

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
  if (result.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    throw new Error(
      `bridge protocol version mismatch: expected ${BRIDGE_PROTOCOL_VERSION}, got ${result.protocolVersion}`,
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

export interface NegotiatedBridgeDependencies {
  connect?: (pipePath: string) => Promise<BridgeConnection>;
  negotiate?: (bridge: BridgeConnection) => Promise<InitializeResult>;
}

/** Opens and negotiates a real daemon bridge, closing it on any handshake failure. */
export async function connectNegotiatedBridge(
  pipePath: string,
  dependencies: NegotiatedBridgeDependencies = {},
): Promise<BridgeConnection> {
  const bridge = await (dependencies.connect ?? connectToDaemon)(pipePath);
  try {
    await (dependencies.negotiate ?? negotiateProtocolVersion)(bridge);
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
