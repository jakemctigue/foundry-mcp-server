import path from "node:path";
import fs from "node:fs";
import { BRIDGE_PROTOCOL_VERSION } from "@foundry-mcp/protocol";
import { DEFAULT_CONFIG, resolveConfig, type HostConfig } from "./config.js";
import { resolveAppDataDir } from "./paths.js";
import { createLogger, stderrSink, type Logger } from "./logger.js";
import { openDatabase, runMigrations } from "./db/index.js";
import { startPipeServer, type PipeServerHandle } from "./bridge/pipe-server.js";
import { resolvePipePath, defaultUserIdentifier } from "./bridge/pipe-path.js";
import { loadOrCreateBridgeAuthKey } from "./bridge/bridge-auth.js";
import type Database from "better-sqlite3";

export interface Daemon {
  config: HostConfig;
  logger: Logger;
  db: Database.Database;
  pipe: PipeServerHandle;
  pipePath: string;
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  shutdown: () => Promise<void>;
}

export interface StartDaemonOptions {
  cliConfig?: Partial<HostConfig>;
  appDataDir?: string;
}

function handleBridgeMessage(message: unknown, respond: (response: unknown) => void): void {
  const request = message as { id?: string; method?: string };
  if (request.method === "initialize") {
    respond({ id: request.id, result: { protocolVersion: BRIDGE_PROTOCOL_VERSION } });
    return;
  }
  if (request.method === "connections.list") {
    respond({ id: request.id, result: { connections: [] } });
    return;
  }
  respond({ id: request.id, result: null });
}

export async function startDaemon(options: StartDaemonOptions = {}): Promise<Daemon> {
  const appDataDir = options.appDataDir ?? resolveAppDataDir();
  fs.mkdirSync(appDataDir, { recursive: true });

  const config = resolveConfig({}, process.env, options.cliConfig ?? {});
  const logger = createLogger({ level: config.logLevel, sinks: [stderrSink()] });

  const dbPath = path.isAbsolute(config.dbPath)
    ? config.dbPath
    : path.join(appDataDir, config.dbPath);
  const db = openDatabase(dbPath);
  runMigrations(db);

  const userIdentifier = defaultUserIdentifier();
  const pipeIdentifier =
    config.pipeName === DEFAULT_CONFIG.pipeName
      ? userIdentifier
      : `${userIdentifier}:${config.pipeName}`;
  const pipePath = resolvePipePath(pipeIdentifier, appDataDir);
  const bridgeAuthKey = await loadOrCreateBridgeAuthKey(appDataDir, logger);
  const pipe = await startPipeServer({
    pipePath,
    logger,
    authKey: bridgeAuthKey,
    onMessage: handleBridgeMessage,
  });

  return {
    config,
    logger,
    db,
    pipe,
    pipePath,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    shutdown: async () => {
      await pipe.close();
      db.close();
    },
  };
}
