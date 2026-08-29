#!/usr/bin/env node
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import {
  DEFAULT_CONFIG,
  defaultUserIdentifier,
  resolveAppDataDir,
  resolveConfig,
  resolvePipePath,
} from "@foundry-mcp/host";
import {
  connectNegotiatedBridge,
  type BridgeConnection,
} from "./bridge-connection.js";
import { createFoundryMcpServer } from "./server.js";

async function resolveBridge(): Promise<BridgeConnection> {
  const appDataDir = resolveAppDataDir();
  const config = resolveConfig({}, process.env);
  const userIdentifier = defaultUserIdentifier();
  const pipeIdentifier =
    config.pipeName === DEFAULT_CONFIG.pipeName
      ? userIdentifier
      : `${userIdentifier}:${config.pipeName}`;
  const pipePath = resolvePipePath(pipeIdentifier, appDataDir);
  return connectNegotiatedBridge(pipePath);
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
