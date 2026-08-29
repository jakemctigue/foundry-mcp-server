#!/usr/bin/env node
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { resolvePipePath, defaultUserIdentifier, resolveAppDataDir } from "@foundry-mcp/host";
import {
  connectToDaemon,
  createStubBridgeConnection,
  negotiateProtocolVersion,
  type BridgeConnection,
} from "./bridge-connection.js";
import { createFoundryMcpServer } from "./server.js";

async function resolveBridge(): Promise<BridgeConnection> {
  const appDataDir = resolveAppDataDir();
  const pipePath = resolvePipePath(defaultUserIdentifier(), appDataDir);
  try {
    const bridge = await connectToDaemon(pipePath);
    await negotiateProtocolVersion(bridge);
    return bridge;
  } catch {
    return createStubBridgeConnection();
  }
}

async function main(): Promise<void> {
  const bridge = await resolveBridge();
  const buildServer = () => createFoundryMcpServer({ bridge });
  let stdio: StdioServerHandle | undefined;
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await stdio?.close();
    await bridge.close();
  };

  stdio = serveStdio(() => buildServer(), {
    onerror: (error) => {
      process.stderr.write(`foundry-mcp-adapter stdio error: ${error.message}\n`);
    },
  });

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.stdin.once("end", () => void shutdown());
}

main().catch((err: unknown) => {
  process.stderr.write(`foundry-mcp-adapter failed to start: ${String(err)}\n`);
  process.exitCode = 1;
});
