import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";

export interface SecretStorage {
  save: (key: string, value: Buffer) => Promise<void>;
  load: (key: string) => Promise<Buffer | undefined>;
}

const DEV_FALLBACK_WARNING =
  "using AES-256-GCM encrypted-file secret storage: development fallback, not for production Windows use";

interface DpapiModule {
  protectData: (
    data: Uint8Array,
    entropy: Uint8Array | null,
    scope: "CurrentUser" | "LocalMachine",
  ) => Uint8Array;
  unprotectData: (
    data: Uint8Array,
    entropy: Uint8Array | null,
    scope: "CurrentUser" | "LocalMachine",
  ) => Uint8Array;
}

interface DpapiImport {
  Dpapi?: DpapiModule;
  default?: DpapiModule | { Dpapi?: DpapiModule };
}

async function loadDpapi(): Promise<DpapiModule | undefined> {
  if (process.platform !== "win32") {
    return undefined;
  }
  try {
    const mod = (await import("@primno/dpapi")) as unknown as DpapiImport;
    const nestedDefault = mod.default && "Dpapi" in mod.default ? mod.default.Dpapi : undefined;
    const directDefault =
      mod.default && "protectData" in mod.default && "unprotectData" in mod.default
        ? mod.default
        : undefined;
    return mod.Dpapi ?? nestedDefault ?? directDefault;
  } catch {
    return undefined;
  }
}

function deriveFallbackKey(): Buffer {
  // Derived from a fixed, non-secret application string plus the OS
  // username; this is explicitly a development-only fallback and is
  // documented/warned as such, not a substitute for DPAPI on Windows.
  const material = `foundry-mcp-dev-fallback:${process.env["USERNAME"] ?? process.env["USER"] ?? "unknown"}`;
  return crypto.createHash("sha256").update(material).digest();
}

function encryptFallback(plaintext: Buffer): Buffer {
  const key = deriveFallbackKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

function decryptFallback(blob: Buffer): Buffer {
  const key = deriveFallbackKey();
  const iv = blob.subarray(0, 12);
  const authTag = blob.subarray(12, 28);
  const encrypted = blob.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

export interface CreateSecretStorageOptions {
  dir: string;
  logger: Logger;
  forceFallback?: boolean;
}

/**
 * Creates a secret storage backend. On Windows, secrets are protected via
 * DPAPI (current-user scope). If DPAPI is unavailable (non-Windows, or the
 * native module fails to load), falls back to an AES-256-GCM encrypted file
 * and logs an explicit warning that this fallback is not for production use.
 */
export function createSecretStorage(options: CreateSecretStorageOptions): SecretStorage {
  const { dir, logger } = options;

  async function resolveDpapi(): Promise<DpapiModule | undefined> {
    if (options.forceFallback) {
      return undefined;
    }
    return loadDpapi();
  }

  return {
    async save(key: string, value: Buffer): Promise<void> {
      const filePath = path.join(dir, `${key}.secret`);
      fs.mkdirSync(dir, { recursive: true });
      const dpapi = await resolveDpapi();
      if (dpapi) {
        try {
          const protectedData = dpapi.protectData(value, null, "CurrentUser");
          fs.writeFileSync(filePath, Buffer.from(protectedData));
          return;
        } catch {
          // A package can import successfully while lacking a prebuild for the
          // current Node ABI. That is unavailable DPAPI, not authorization to
          // write an unprotected secret; continue into the encrypted fallback.
        }
      }
      logger.warn(DEV_FALLBACK_WARNING, { key });
      fs.writeFileSync(filePath, encryptFallback(value));
    },
    async load(key: string): Promise<Buffer | undefined> {
      const filePath = path.join(dir, `${key}.secret`);
      if (!fs.existsSync(filePath)) {
        return undefined;
      }
      const blob = fs.readFileSync(filePath);
      const dpapi = await resolveDpapi();
      if (dpapi) {
        try {
          return Buffer.from(dpapi.unprotectData(blob, null, "CurrentUser"));
        } catch {
          // See the save path above. The fallback decrypt remains
          // authenticated and throws if this was not a fallback-format blob.
        }
      }
      logger.warn(DEV_FALLBACK_WARNING, { key });
      return decryptFallback(blob);
    },
  };
}

export { DEV_FALLBACK_WARNING };
