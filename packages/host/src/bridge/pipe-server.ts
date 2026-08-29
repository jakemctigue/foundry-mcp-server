import fs from "node:fs";
import net from "node:net";
import type { Logger } from "../logger.js";
import { defaultAclCheck, enforceAcl, type AclCheck } from "./acl.js";
import {
  BridgeAuthenticator,
  createBridgeAuthChallenge,
  createBridgeAuthReady,
  isBridgeAuthInit,
  isBridgeAuthProof,
  isBridgeRequestAuthorized,
  registerInProcessBridgeAuthKey,
  unregisterInProcessBridgeAuthKey,
} from "./bridge-auth.js";
import {
  startWindowsPipeBroker,
  type BrokerClientIdentity,
  type BrokerReadyIdentity,
  type WindowsPipeBrokerHandle,
} from "./windows-pipe-broker.js";

const LENGTH_PREFIX_BYTES = 4;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function encodeFrame(message: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  if (json.length > MAX_FRAME_BYTES) {
    throw new Error("bridge frame exceeds the maximum size");
  }
  const header = Buffer.alloc(LENGTH_PREFIX_BYTES);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

export class FrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    for (;;) {
      if (this.buffer.length < LENGTH_PREFIX_BYTES) {
        break;
      }
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        throw new Error("bridge frame exceeds the maximum size");
      }
      if (this.buffer.length < LENGTH_PREFIX_BYTES + length) {
        break;
      }
      const body = this.buffer.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length);
      this.buffer = this.buffer.subarray(LENGTH_PREFIX_BYTES + length);
      messages.push(JSON.parse(body.toString("utf8")));
    }
    return messages;
  }
}

export interface ClientTokenContext {
  platform: NodeJS.Platform;
  tokenVerified: boolean;
  clientUserSid?: string | undefined;
  clientLogonSid?: string | undefined;
  expectedUserSid?: string | undefined;
  expectedLogonSid?: string | undefined;
}

export type ClientTokenCheck = (context: ClientTokenContext) => boolean | Promise<boolean>;

export const defaultClientTokenCheck: ClientTokenCheck = (context) => {
  if (context.platform !== "win32") {
    return true;
  }
  return (
    context.tokenVerified === true &&
    typeof context.clientUserSid === "string" &&
    typeof context.clientLogonSid === "string" &&
    context.clientUserSid === context.expectedUserSid &&
    context.clientLogonSid === context.expectedLogonSid
  );
};

export interface PipeServerOptions {
  pipePath: string;
  logger: Logger;
  authKey?: Buffer;
  aclCheck?: AclCheck;
  clientTokenCheck?: ClientTokenCheck;
  brokerExecutablePath?: string;
  onMessage: (message: unknown, respond: (response: unknown) => void) => void;
}

export interface PipeServerHandle {
  ready: boolean;
  close: () => Promise<void>;
}

interface AuthorizedConnection {
  decoder: FrameDecoder;
  authenticator: BridgeAuthenticator;
  tokenAllowed: Promise<boolean>;
  initialized: boolean;
  authenticated: boolean;
}

function createAuthorizedConnection(
  authKey: Buffer,
  tokenAllowed: Promise<boolean>,
): { connection: AuthorizedConnection; challenge: unknown } {
  const { challenge, session } = createBridgeAuthChallenge();
  return {
    connection: {
      decoder: new FrameDecoder(),
      authenticator: new BridgeAuthenticator(authKey, {
        session,
        signDirection: "server-to-client",
        verifyDirection: "client-to-server",
      }),
      tokenAllowed,
      initialized: false,
      authenticated: false,
    },
    challenge,
  };
}

function failedHandle(): PipeServerHandle {
  return { ready: false, close: () => Promise.resolve() };
}

function validateAuthKey(options: PipeServerOptions): Buffer | undefined {
  if (!options.authKey || options.authKey.length !== 32) {
    options.logger.error("bridge HMAC key is missing or invalid; refusing to become ready", {
      pipePath: options.pipePath,
    });
    return undefined;
  }
  return options.authKey;
}

async function processAuthenticatedChunk(
  connection: AuthorizedConnection,
  chunk: Buffer,
  aclAllowed: boolean,
  logger: Logger,
  onMessage: PipeServerOptions["onMessage"],
  respond: (response: Buffer) => void,
  reject: () => void,
): Promise<void> {
  const tokenAllowed = await connection.tokenAllowed;
  if (!isBridgeRequestAuthorized(aclAllowed && tokenAllowed, true)) {
    logger.warn("bridge client token check failed; closing connection");
    reject();
    return;
  }

  let frames: unknown[];
  try {
    frames = connection.decoder.push(chunk);
  } catch (error) {
    logger.warn("bridge framing failed closed", {
      error: error instanceof Error ? error.message : String(error),
    });
    reject();
    return;
  }

  for (const frame of frames) {
    if (!connection.initialized) {
      if (!isBridgeAuthInit(frame)) {
        logger.warn("bridge authentication initialization failed; closing connection");
        reject();
        return;
      }
      connection.initialized = true;
      continue;
    }
    const verification = connection.authenticator.verify(frame);
    if (!isBridgeRequestAuthorized(aclAllowed && tokenAllowed, verification.ok)) {
      logger.warn("bridge HMAC check failed; closing connection", {
        reason: verification.reason ?? "authentication failed",
      });
      reject();
      return;
    }
    if (!connection.authenticated) {
      if (!isBridgeAuthProof(verification.message)) {
        logger.warn("bridge authentication proof failed; closing connection");
        reject();
        return;
      }
      connection.authenticated = true;
      respond(encodeFrame(connection.authenticator.sign(createBridgeAuthReady())));
      continue;
    }
    onMessage(verification.message, (response) => {
      respond(encodeFrame(connection.authenticator.sign(response)));
    });
  }
}

async function startUnixPipeServer(
  options: PipeServerOptions,
  authKey: Buffer,
): Promise<PipeServerHandle> {
  const { pipePath, logger, onMessage } = options;
  const aclCheck = options.aclCheck ?? defaultAclCheck;
  const clientTokenCheck = options.clientTokenCheck ?? defaultClientTokenCheck;

  if (fs.existsSync(pipePath)) {
    fs.unlinkSync(pipePath);
  }

  let aclAllowed = false;
  const server = net.createServer((socket) => {
    const created = createAuthorizedConnection(
      authKey,
      Promise.resolve(clientTokenCheck({ platform: process.platform, tokenVerified: true })),
    );
    const connection = created.connection;
    socket.write(encodeFrame(created.challenge));
    socket.on("data", (chunk: Buffer) => {
      void processAuthenticatedChunk(
        connection,
        chunk,
        aclAllowed,
        logger,
        onMessage,
        (response) => socket.write(response),
        () => socket.destroy(),
      );
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(pipePath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    fs.chmodSync(pipePath, 0o600);
    aclAllowed = await enforceAcl(pipePath, aclCheck, logger);
    if (!aclAllowed) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return failedHandle();
    }
  } catch (error) {
    server.close();
    throw error;
  }

  registerInProcessBridgeAuthKey(pipePath, authKey);
  logger.info("bridge Unix-domain socket server listening", { pipePath, mode: "0600" });
  return {
    ready: true,
    close: async () => {
      unregisterInProcessBridgeAuthKey(pipePath);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function startWindowsPipeServer(
  options: PipeServerOptions,
  authKey: Buffer,
): Promise<PipeServerHandle> {
  const { pipePath, logger, onMessage } = options;
  const aclCheck = options.aclCheck ?? defaultAclCheck;
  const clientTokenCheck = options.clientTokenCheck ?? defaultClientTokenCheck;
  const connections = new Map<string, AuthorizedConnection>();
  let aclAllowed = false;
  let readyIdentity: BrokerReadyIdentity | undefined;
  let broker: WindowsPipeBrokerHandle;

  try {
    broker = await startWindowsPipeBroker({
      pipePath,
      logger,
      executablePath: options.brokerExecutablePath,
      onConnected: (identity: BrokerClientIdentity) => {
        const expected = readyIdentity;
        const created = createAuthorizedConnection(
          authKey,
          Promise.resolve(
            clientTokenCheck({
              platform: "win32",
              tokenVerified: identity.tokenVerified,
              clientUserSid: identity.clientUserSid,
              clientLogonSid: identity.clientLogonSid,
              expectedUserSid: expected?.ownerSid,
              expectedLogonSid: expected?.logonSid,
            }),
          ),
        );
        connections.set(identity.connectionId, created.connection);
        broker.send(identity.connectionId, encodeFrame(created.challenge));
      },
      onData: async (connectionId, data) => {
        if (!aclAllowed) {
          // The independent descriptor probe opens the pipe and writes one
          // sentinel byte while readiness is still denied. Never feed that
          // probe byte into application framing or report it as a client
          // authentication failure.
          broker.closeConnection(connectionId);
          return;
        }
        const connection = connections.get(connectionId);
        if (!connection) {
          logger.warn("Windows pipe broker sent data for an unauthorized connection", {
            connectionId,
          });
          broker.closeConnection(connectionId);
          return;
        }
        await processAuthenticatedChunk(
          connection,
          data,
          aclAllowed,
          logger,
          onMessage,
          (response) => broker.send(connectionId, response),
          () => broker.closeConnection(connectionId),
        );
      },
      onDisconnected: (connectionId) => {
        connections.delete(connectionId);
      },
    });
    readyIdentity = broker.identity;
  } catch (error) {
    logger.error("Windows pipe broker failed closed before readiness", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failedHandle();
  }

  aclAllowed = await enforceAcl(pipePath, aclCheck, logger);
  if (!aclAllowed) {
    await broker.close();
    return failedHandle();
  }

  registerInProcessBridgeAuthKey(pipePath, authKey);
  logger.info("bridge Windows named-pipe broker listening", {
    pipePath,
    ownerSid: readyIdentity.ownerSid,
    logonSid: readyIdentity.logonSid,
  });
  return {
    ready: true,
    close: async () => {
      unregisterInProcessBridgeAuthKey(pipePath);
      connections.clear();
      await broker.close();
    },
  };
}

export async function startPipeServer(options: PipeServerOptions): Promise<PipeServerHandle> {
  const authKey = validateAuthKey(options);
  if (!authKey) {
    return failedHandle();
  }
  if (process.platform === "win32") {
    return startWindowsPipeServer(options, authKey);
  }
  return startUnixPipeServer(options, authKey);
}
