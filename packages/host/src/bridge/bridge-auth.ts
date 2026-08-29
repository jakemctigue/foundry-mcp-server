import crypto from "node:crypto";
import path from "node:path";
import type { Logger } from "../logger.js";
import { resolveAppDataDir } from "../paths.js";
import { createSecretStorage } from "../secrets/storage.js";

const AUTH_DOMAIN = Buffer.from("foundry-mcp-bridge-v1\0", "utf8");
const AUTH_VERSION = 1;
const AUTH_INIT_TYPE = "bridge-auth-init";
const AUTH_CHALLENGE_TYPE = "bridge-auth-challenge";
const AUTH_PROOF_TYPE = "bridge-auth-proof";
const AUTH_READY_TYPE = "bridge-auth-ready";
const MAX_AUTHENTICATED_FRAMES_PER_CONNECTION = 4_096;
const MAX_AUTHENTICATED_PAYLOAD_BYTES = 16 * 1024 * 1024;
const BRIDGE_AUTH_SECRET_NAME = "bridge-auth";

export const BRIDGE_AUTH_KEY_BYTES = 32;
export const BRIDGE_AUTH_SESSION_BYTES = 32;
export type BridgeAuthDirection = "client-to-server" | "server-to-client";

export interface BridgeAuthChallenge {
  type: typeof AUTH_CHALLENGE_TYPE;
  version: 1;
  session: string;
}

export interface BridgeAuthInit {
  type: typeof AUTH_INIT_TYPE;
  version: 1;
}

export interface BridgeAuthProof {
  type: typeof AUTH_PROOF_TYPE;
  version: 1;
}

export interface BridgeAuthReady {
  type: typeof AUTH_READY_TYPE;
  version: 1;
}

export interface BridgeAuthenticatorOptions {
  session: Buffer;
  signDirection: BridgeAuthDirection;
  verifyDirection: BridgeAuthDirection;
}

export interface BridgeAuthEnvelope {
  version: 1;
  nonce: string;
  payload: string;
  mac: string;
}

export interface BridgeAuthVerification {
  ok: boolean;
  message?: unknown;
  reason?: string;
}

const inProcessKeys = new Map<string, Buffer>();

function requireKey(key: Buffer): void {
  if (key.length !== BRIDGE_AUTH_KEY_BYTES) {
    throw new Error(`bridge HMAC key must be exactly ${BRIDGE_AUTH_KEY_BYTES.toString()} bytes`);
  }
}

function canonicalBase64Url(value: string, expectedBytes: number | undefined): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return undefined;
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    return undefined;
  }
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    return undefined;
  }
  return decoded;
}

function calculateMac(
  key: Buffer,
  session: Buffer,
  direction: BridgeAuthDirection,
  nonce: Buffer,
  payload: Buffer,
): Buffer {
  return crypto
    .createHmac("sha256", key)
    .update(AUTH_DOMAIN)
    .update(session)
    .update(Buffer.from(`${direction}\0`, "utf8"))
    .update(nonce)
    .update(payload)
    .digest();
}

export function createBridgeAuthChallenge(): {
  challenge: BridgeAuthChallenge;
  session: Buffer;
} {
  const session = crypto.randomBytes(BRIDGE_AUTH_SESSION_BYTES);
  return {
    challenge: {
      type: AUTH_CHALLENGE_TYPE,
      version: AUTH_VERSION,
      session: session.toString("base64url"),
    },
    session,
  };
}

export function createBridgeAuthInit(): BridgeAuthInit {
  return { type: AUTH_INIT_TYPE, version: AUTH_VERSION };
}

export function createBridgeAuthProof(): BridgeAuthProof {
  return { type: AUTH_PROOF_TYPE, version: AUTH_VERSION };
}

export function createBridgeAuthReady(): BridgeAuthReady {
  return { type: AUTH_READY_TYPE, version: AUTH_VERSION };
}

function isExactHandshakeMessage(
  value: unknown,
  type: typeof AUTH_INIT_TYPE | typeof AUTH_PROOF_TYPE | typeof AUTH_READY_TYPE,
): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === type &&
    (value as { version?: unknown }).version === AUTH_VERSION &&
    Object.keys(value).length === 2
  );
}

export function isBridgeAuthInit(value: unknown): value is BridgeAuthInit {
  return isExactHandshakeMessage(value, AUTH_INIT_TYPE);
}

export function isBridgeAuthProof(value: unknown): value is BridgeAuthProof {
  return isExactHandshakeMessage(value, AUTH_PROOF_TYPE);
}

export function isBridgeAuthReady(value: unknown): value is BridgeAuthReady {
  return isExactHandshakeMessage(value, AUTH_READY_TYPE);
}

export function parseBridgeAuthChallenge(value: unknown): Buffer | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    (value as { type?: unknown }).type !== AUTH_CHALLENGE_TYPE ||
    (value as { version?: unknown }).version !== AUTH_VERSION ||
    typeof (value as { session?: unknown }).session !== "string"
  ) {
    return undefined;
  }
  if (Object.keys(value).length !== 3) {
    return undefined;
  }
  return canonicalBase64Url((value as { session: string }).session, BRIDGE_AUTH_SESSION_BYTES);
}

export class BridgeAuthenticator {
  private readonly seenNonces = new Set<string>();
  private readonly key: Buffer;
  private readonly session: Buffer;
  private readonly signDirection: BridgeAuthDirection;
  private readonly verifyDirection: BridgeAuthDirection;

  constructor(key: Buffer, options: BridgeAuthenticatorOptions) {
    requireKey(key);
    if (options.session.length !== BRIDGE_AUTH_SESSION_BYTES) {
      throw new Error(
        `bridge HMAC session must be exactly ${BRIDGE_AUTH_SESSION_BYTES.toString()} bytes`,
      );
    }
    this.key = Buffer.from(key);
    this.session = Buffer.from(options.session);
    this.signDirection = options.signDirection;
    this.verifyDirection = options.verifyDirection;
  }

  sign(message: unknown): BridgeAuthEnvelope {
    const json = JSON.stringify(message);
    if (json === undefined) {
      throw new Error("bridge message is not JSON serializable");
    }
    const payload = Buffer.from(json, "utf8");
    if (payload.length > MAX_AUTHENTICATED_PAYLOAD_BYTES) {
      throw new Error("bridge message exceeds the authenticated payload limit");
    }
    const nonce = crypto.randomBytes(16);
    return {
      version: AUTH_VERSION,
      nonce: nonce.toString("base64url"),
      payload: payload.toString("base64url"),
      mac: calculateMac(this.key, this.session, this.signDirection, nonce, payload).toString(
        "base64url",
      ),
    };
  }

  verify(value: unknown): BridgeAuthVerification {
    if (
      !value ||
      typeof value !== "object" ||
      (value as { version?: unknown }).version !== AUTH_VERSION ||
      typeof (value as { nonce?: unknown }).nonce !== "string" ||
      typeof (value as { payload?: unknown }).payload !== "string" ||
      typeof (value as { mac?: unknown }).mac !== "string"
    ) {
      return { ok: false, reason: "malformed authenticated bridge envelope" };
    }

    const envelope = value as BridgeAuthEnvelope;
    const nonce = canonicalBase64Url(envelope.nonce, 16);
    const payload = canonicalBase64Url(envelope.payload, undefined);
    const suppliedMac = canonicalBase64Url(envelope.mac, 32);
    if (!nonce || !payload || !suppliedMac || payload.length > MAX_AUTHENTICATED_PAYLOAD_BYTES) {
      return { ok: false, reason: "invalid authenticated bridge envelope encoding" };
    }
    if (this.seenNonces.has(envelope.nonce)) {
      return { ok: false, reason: "replayed authenticated bridge envelope" };
    }
    if (this.seenNonces.size >= MAX_AUTHENTICATED_FRAMES_PER_CONNECTION) {
      return { ok: false, reason: "authenticated bridge connection frame budget exhausted" };
    }

    const expectedMac = calculateMac(this.key, this.session, this.verifyDirection, nonce, payload);
    if (!crypto.timingSafeEqual(expectedMac, suppliedMac)) {
      return { ok: false, reason: "bridge HMAC verification failed" };
    }

    try {
      const message: unknown = JSON.parse(payload.toString("utf8"));
      this.seenNonces.add(envelope.nonce);
      return { ok: true, message };
    } catch {
      return { ok: false, reason: "authenticated bridge payload is not valid JSON" };
    }
  }
}

export function isBridgeRequestAuthorized(
  aclAndTokenAllowed: boolean,
  hmacAllowed: boolean,
): boolean {
  return aclAndTokenAllowed === true && hmacAllowed === true;
}

function secretDirectory(appDataDir: string): string {
  return path.join(appDataDir, "secrets");
}

export interface BridgeAuthKeyStorageOptions {
  allowDevelopmentFallback?: boolean;
}

export async function loadOrCreateBridgeAuthKey(
  appDataDir: string,
  logger: Logger,
  options: BridgeAuthKeyStorageOptions = {},
): Promise<Buffer> {
  const storage = createSecretStorage({
    dir: secretDirectory(appDataDir),
    logger,
    allowDevelopmentFallback: options.allowDevelopmentFallback === true,
  });
  const existing = await storage.load(BRIDGE_AUTH_SECRET_NAME);
  if (existing) {
    requireKey(existing);
    return existing;
  }
  const generated = crypto.randomBytes(BRIDGE_AUTH_KEY_BYTES);
  await storage.save(BRIDGE_AUTH_SECRET_NAME, generated);
  return generated;
}

export async function loadExistingBridgeAuthKey(
  appDataDir: string = resolveAppDataDir(),
  options: BridgeAuthKeyStorageOptions = {},
): Promise<Buffer | undefined> {
  const silentLogger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const storage = createSecretStorage({
    dir: secretDirectory(appDataDir),
    logger: silentLogger,
    allowDevelopmentFallback: options.allowDevelopmentFallback === true,
  });
  const key = await storage.load(BRIDGE_AUTH_SECRET_NAME);
  if (key) {
    requireKey(key);
  }
  return key;
}

export function registerInProcessBridgeAuthKey(pipePath: string, key: Buffer): void {
  requireKey(key);
  inProcessKeys.set(pipePath, Buffer.from(key));
}

export function unregisterInProcessBridgeAuthKey(pipePath: string): void {
  const key = inProcessKeys.get(pipePath);
  key?.fill(0);
  inProcessKeys.delete(pipePath);
}

export function findInProcessBridgeAuthKey(pipePath: string): Buffer | undefined {
  const key = inProcessKeys.get(pipePath);
  return key ? Buffer.from(key) : undefined;
}
