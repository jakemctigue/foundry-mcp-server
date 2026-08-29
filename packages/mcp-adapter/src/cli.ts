#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
  const server = createFoundryMcpServer({ bridge });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(`foundry-mcp-adapter failed to start: ${String(err)}\n`);
  process.exitCode = 1;
});
