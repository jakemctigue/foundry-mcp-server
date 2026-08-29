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
import { startHostCompanionServer, type HostCompanionServer } from "./bridge/companion-server.js";
import { HostBridgeRouter } from "./bridge/router.js";
import { createImageProviderRegistry } from "./providers/images.js";
import { createSecretStorage } from "./secrets/storage.js";

export interface Daemon {
  config: HostConfig;
  logger: Logger;
  db: Database.Database;
  pipe: PipeServerHandle;
  pipePath: string;
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  companion: HostCompanionServer;
  companionEndpoint: string;
  shutdown: () => Promise<void>;
}

export interface StartDaemonOptions {
  cliConfig?: Partial<HostConfig>;
  appDataDir?: string;
  /** Explicit test/embed override; production loads the DPAPI-protected pairing secret. */
  companionPairingSecret?: Buffer;
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
  const secretStorage = createSecretStorage({
    dir: path.join(appDataDir, "secrets"),
    logger,
    allowDevelopmentFallback:
      process.env["NODE_ENV"] === "development" || process.env["NODE_ENV"] === "test",
  });
  const companionPairingSecret =
    options.companionPairingSecret ?? (await secretStorage.load("pairing"));
  if (!companionPairingSecret) {
    db.close();
    throw new Error("companion pairing secret is missing; run the pairing workflow first");
  }
  const companion = await startHostCompanionServer({
    port: config.port,
    allowedOrigins: config.allowedOrigins,
    db,
    pairingSecret: companionPairingSecret,
    capture: {
      categories: config.eventCategories,
      capturePrivateContent: config.capturePrivateContent,
    },
  });
  const companionEndpoint = companion.address().endpoint;
  let companionClosed = false;
  const imageProviders = await createImageProviderRegistry({
    secretStorage,
    openAi: { logger },
  });
  const router = new HostBridgeRouter(
    db,
    companion,
    imageProviders,
    undefined,
    (error, committed) =>
      logger.error("mutation audit write failed", {
        committed,
        errorType: error.name,
      }),
  );
  const pipe = await startPipeServer({
    pipePath,
    logger,
    authKey: bridgeAuthKey,
    onMessage: (message, respond) => router.handle(message, respond),
  });
  if (!pipe.ready) {
    await companion.close();
    companionClosed = true;
  }

  return {
    config,
    logger,
    db,
    pipe,
    pipePath,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    companion,
    companionEndpoint,
    shutdown: async () => {
      await pipe.close();
      if (!companionClosed) {
        await companion.close();
        companionClosed = true;
      }
      db.close();
    },
  };
}
