#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

interface AdapterProcessLike {
  exitCode: string | number | null | undefined;
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  stdin: { once(event: "end", listener: () => void): unknown };
  stderr: { write(message: string): unknown };
}

type AdapterServe = (
  factory: () => ReturnType<typeof createFoundryMcpServer>,
  options: { onerror(error: Error): void },
) => Pick<StdioServerHandle, "close">;

export interface RunAdapterCliOptions {
  bridgeFactory?: () => Promise<BridgeConnection>;
  serverFactory?: typeof createFoundryMcpServer;
  serve?: AdapterServe;
  runtimeProcess?: AdapterProcessLike;
}

export interface AdapterCliLifecycle {
  shutdown(): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export async function runAdapterCli(
  options: RunAdapterCliOptions = {},
): Promise<AdapterCliLifecycle> {
  const bridge = await (options.bridgeFactory ?? resolveBridge)();
  const serverFactory = options.serverFactory ?? createFoundryMcpServer;
  const serve = options.serve ?? serveStdio;
  const runtimeProcess: AdapterProcessLike = options.runtimeProcess ?? process;
  let stdio: Pick<StdioServerHandle, "close"> | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const reportFailure = (context: string, error: unknown): void => {
    runtimeProcess.exitCode = 1;
    runtimeProcess.stderr.write(`foundry-mcp-adapter ${context}: ${errorMessage(error)}\n`);
  };

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(async () => stdio?.close()),
        Promise.resolve().then(async () => bridge.close()),
      ]);
      const errors = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      );
      if (errors.length > 0) throw new AggregateError(errors, "adapter shutdown failed");
    })();
    return shutdownPromise;
  };

  const requestShutdown = (): void => {
    queueMicrotask(() => {
      void shutdown().catch((error: unknown) => reportFailure("shutdown failed", error));
    });
  };

  try {
    stdio = serve(() => serverFactory({ bridge }), {
      onerror: (error) => {
        reportFailure("stdio error", error);
        requestShutdown();
      },
    });
  } catch (error) {
    const cleanup = await Promise.allSettled([bridge.close()]);
    const cleanupErrors = cleanup.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "adapter startup cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }

  runtimeProcess.once("SIGINT", requestShutdown);
  runtimeProcess.once("SIGTERM", requestShutdown);
  runtimeProcess.stdin.once("end", requestShutdown);
  return { shutdown };
}

async function main(): Promise<void> {
  await runAdapterCli();
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const resolveRealPath = (candidate: string): string => {
    try {
      return fs.realpathSync.native(candidate);
    } catch {
      return path.resolve(candidate);
    }
  };
  const entryPath = resolveRealPath(entry);
  const modulePath = resolveRealPath(fileURLToPath(import.meta.url));
  return process.platform === "win32"
    ? entryPath.toLocaleLowerCase() === modulePath.toLocaleLowerCase()
    : entryPath === modulePath;
}

if (isDirectExecution()) {
  void main().catch((err: unknown) => {
    process.stderr.write(`foundry-mcp-adapter failed to start: ${String(err)}\n`);
    process.exitCode = 1;
  });
}
