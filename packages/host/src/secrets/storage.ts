import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";
import { createLinuxFileSecretStorage } from "./linux-file-storage.js";
export { writeLinuxPairingCode } from "./linux-file-storage.js";

export interface SecretStorage {
  save: (key: string, value: Buffer) => Promise<void>;
  load: (key: string) => Promise<Buffer | undefined>;
  remove?: (key: string) => Promise<void>;
}

const DEV_FALLBACK_WARNING =
  "using AES-256-GCM encrypted-file secret storage: development fallback, not for production Windows use";
const DEV_FALLBACK_DISABLED_ERROR =
  "OS-protected secret storage is unavailable; encrypted-file fallback requires an explicit non-production development opt-in";

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
  allowDevelopmentFallback?: boolean;
}

function requireDevelopmentFallback(options: CreateSecretStorageOptions): void {
  const runtimeMode = process.env["NODE_ENV"];
  const explicitlyDevelopment =
    options.allowDevelopmentFallback === true ||
    runtimeMode === "development" ||
    runtimeMode === "test";
  if (!explicitlyDevelopment || runtimeMode === "production") {
    throw new Error(DEV_FALLBACK_DISABLED_ERROR);
  }
}

/**
 * Creates a secret storage backend. On Windows, secrets are protected via
 * DPAPI (current-user scope). An AES-256-GCM encrypted-file fallback is
 * available only to explicitly opted-in development/test runtimes and is
 * always refused when NODE_ENV=production.
 * On Linux, FOUNDRY_MCP_SECRET_KEY_FILE selects an independent protected-key
 * production backend for every consumer, including CLI and bridge key loading.
 */
export function createSecretStorage(options: CreateSecretStorageOptions): SecretStorage {
  const { dir, logger } = options;
  const masterKeyFile = process.env["FOUNDRY_MCP_SECRET_KEY_FILE"];
  if (masterKeyFile !== undefined) {
    if (options.forceFallback)
      throw new Error("Linux master key cannot be combined with forced development fallback");
    return createLinuxFileSecretStorage(dir, masterKeyFile);
  }

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
      requireDevelopmentFallback(options);
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
      requireDevelopmentFallback(options);
      logger.warn(DEV_FALLBACK_WARNING, { key });
      return decryptFallback(blob);
    },
    async remove(key: string): Promise<void> {
      const filePath = path.join(dir, `${key}.secret`);
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

export { DEV_FALLBACK_DISABLED_ERROR, DEV_FALLBACK_WARNING };
