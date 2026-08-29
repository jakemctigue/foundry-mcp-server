import crypto from "node:crypto";
import path from "node:path";
import type { Logger } from "../logger.js";
import { resolveAppDataDir } from "../paths.js";
import { createSecretStorage } from "../secrets/storage.js";

const AUTH_DOMAIN = Buffer.from("foundry-mcp-bridge-v1\0", "utf8");
const AUTH_VERSION = 1;
const MAX_AUTHENTICATED_FRAMES_PER_CONNECTION = 4_096;
const MAX_AUTHENTICATED_PAYLOAD_BYTES = 16 * 1024 * 1024;
const BRIDGE_AUTH_SECRET_NAME = "bridge-auth";

export const BRIDGE_AUTH_KEY_BYTES = 32;

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

function calculateMac(key: Buffer, nonce: Buffer, payload: Buffer): Buffer {
  return crypto
    .createHmac("sha256", key)
    .update(AUTH_DOMAIN)
    .update(nonce)
    .update(payload)
    .digest();
}

export class BridgeAuthenticator {
  private readonly seenNonces = new Set<string>();

  constructor(private readonly key: Buffer) {
    requireKey(key);
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
      mac: calculateMac(this.key, nonce, payload).toString("base64url"),
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

    const expectedMac = calculateMac(this.key, nonce, payload);
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

export async function loadOrCreateBridgeAuthKey(
  appDataDir: string,
  logger: Logger,
): Promise<Buffer> {
  const storage = createSecretStorage({ dir: secretDirectory(appDataDir), logger });
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
): Promise<Buffer | undefined> {
  const silentLogger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const storage = createSecretStorage({ dir: secretDirectory(appDataDir), logger: silentLogger });
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
