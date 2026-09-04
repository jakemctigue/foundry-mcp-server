import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SecretStorage } from "./storage.js";
import { base32Encode } from "./pairing.js";

const MAGIC = Buffer.from("FMCP-SECRET-1\0", "ascii");
const MAX_SECRET_BYTES = 1024 * 1024;
const HEADER_BYTES = MAGIC.length + 12 + 16;

function requireName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name)) {
    throw new Error("invalid secret name");
  }
}

function uid(): number {
  if (process.platform !== "linux" || !process.getuid) {
    throw new Error("protected key-file secret storage requires Linux");
  }
  return process.getuid();
}

/** Root and this service account are trusted; other users must not replace path segments. */
function requireTrustedLinuxDirectories(directory: string): void {
  let current = path.resolve(directory);
  for (;;) {
    const stat = fs.lstatSync(current);
    const trustedOwner = stat.uid === 0 || stat.uid === uid();
    // Root-owned sticky /tmp is safe only as an ancestor; the store itself is checked below.
    const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!stat.isDirectory() || !trustedOwner || ((stat.mode & 0o022) !== 0 && !stickyRoot)) {
      throw new Error("Linux secret directory has unsafe ownership, permissions, or links");
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** Bootstrap/recover a Linux pairing code into an exclusive owner-only file, never logs. */
export async function writeLinuxPairingCode(options: {
  appDataDir: string;
  outputFile: string;
}): Promise<void> {
  const owner = uid();
  const masterPath = process.env["FOUNDRY_MCP_SECRET_KEY_FILE"];
  if (masterPath === undefined) {
    throw new Error("Linux pairing requires FOUNDRY_MCP_SECRET_KEY_FILE");
  }
  if (!path.isAbsolute(options.appDataDir) || !path.isAbsolute(options.outputFile)) {
    throw new Error("pairing paths must be absolute");
  }
  const outputFile = path.resolve(options.outputFile);
  const directory = path.dirname(outputFile);
  requireTrustedLinuxDirectories(directory);
  const parent = fs.lstatSync(directory);
  if (parent.uid !== owner || (parent.mode & 0o077) !== 0) {
    throw new Error("pairing output directory must be owner-only (0700)");
  }
  const storage = createLinuxFileSecretStorage(
    path.join(options.appDataDir, "secrets"),
    masterPath,
  );
  // Exclusive creation prevents accidental replacement of an existing code or unrelated file.
  const fd = fs.openSync(outputFile, "wx", 0o600);
  let completed = false;
  let raw: Buffer | undefined;
  try {
    raw = await storage.load("pairing");
    if (!raw) {
      raw = crypto.randomBytes(32);
      await storage.save("pairing", raw);
    }
    if (raw.length !== 32) throw new Error("stored pairing secret must contain exactly 32 bytes");
    fs.writeFileSync(fd, `${base32Encode(raw)}\n`, "utf8");
    fs.fsyncSync(fd);
    completed = true;
  } finally {
    raw?.fill(0);
    fs.closeSync(fd);
    if (!completed) fs.unlinkSync(outputFile);
  }
}

function requirePrivateFile(stat: fs.Stats, masterKey = false): void {
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.uid !== uid() && !(masterKey && stat.uid === 0)) ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error(`Linux ${masterKey ? "master key" : "secret file"} is not owner-protected`);
  }
}

function readProtectedFile(file: string, maximum: number, masterKey = false): Buffer {
  // O_NONBLOCK also avoids blocking on a FIFO before fstat can reject its type.
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    requirePrivateFile(stat, masterKey);
    if (stat.size > maximum) throw new Error("Linux secret file exceeds its size limit");
    const bytes = Buffer.alloc(maximum + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    if (offset > maximum) throw new Error("Linux secret file exceeds its size limit");
    return bytes.subarray(0, offset);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Linux production backend. The independent raw 32-byte key is injected by the
 * operator, never derived from public data, generated implicitly, or written here.
 */
export function createLinuxFileSecretStorage(directory: string, keyFile: string): SecretStorage {
  uid();
  if (!path.isAbsolute(keyFile) || keyFile.includes("\0")) {
    throw new Error("Linux master key must be an absolute file path");
  }
  const dir = path.resolve(directory);
  const masterPath = path.resolve(keyFile);
  const relative = path.relative(dir, masterPath);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    throw new Error("Linux master key must be outside the encrypted secret directory");
  }

  function readMasterKey(): Buffer {
    requireTrustedLinuxDirectories(path.dirname(masterPath));
    let key: Buffer;
    try {
      key = readProtectedFile(masterPath, 32, true);
    } catch {
      throw new Error(
        "Linux master key must be an owner-protected regular file containing exactly 32 raw bytes",
      );
    }
    if (key.length !== 32) {
      key.fill(0);
      throw new Error("Linux master key must contain exactly 32 raw bytes");
    }
    return key;
  }
  // Fail closed even for a status/read of a credential that does not exist yet.
  readMasterKey().fill(0);

  function requireStore(create: boolean): boolean {
    let existing = dir;
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    requireTrustedLinuxDirectories(existing);
    if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    else if (!fs.existsSync(dir)) return false;
    requireTrustedLinuxDirectories(dir);
    const stat = fs.lstatSync(dir);
    if (stat.uid !== uid() || (stat.mode & 0o077) !== 0) {
      throw new Error("Linux secret directory must be owned by this account with mode 0700");
    }
    return true;
  }

  function existingFile(file: string): boolean {
    try {
      requirePrivateFile(fs.lstatSync(file));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  return {
    async save(name, value) {
      requireName(name);
      if (value.length > MAX_SECRET_BYTES) throw new Error("secret exceeds its size limit");
      requireStore(true);
      const file = path.join(dir, `${name}.secret`);
      existingFile(file);
      const key = readMasterKey();
      let blob: Buffer;
      try {
        const nonce = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(Buffer.concat([MAGIC, Buffer.from(name, "utf8")]));
        const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
        blob = Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), encrypted]);
      } finally {
        key.fill(0);
      }
      const temporary = path.join(dir, `.${name}.${crypto.randomBytes(16).toString("hex")}.tmp`);
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        try {
          fs.writeFileSync(fd, blob);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        requireStore(false);
        existingFile(file);
        fs.renameSync(temporary, file);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    },
    async load(name) {
      requireName(name);
      if (!requireStore(false)) return undefined;
      const file = path.join(dir, `${name}.secret`);
      if (!existingFile(file)) return undefined;
      const blob = readProtectedFile(file, MAX_SECRET_BYTES + HEADER_BYTES);
      if (blob.length < HEADER_BYTES || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error(
          "unrecognized Linux encrypted secret format; automatic migration is disabled",
        );
      }
      const key = readMasterKey();
      try {
        const decipher = crypto.createDecipheriv(
          "aes-256-gcm",
          key,
          blob.subarray(MAGIC.length, MAGIC.length + 12),
        );
        decipher.setAAD(Buffer.concat([MAGIC, Buffer.from(name, "utf8")]));
        decipher.setAuthTag(blob.subarray(MAGIC.length + 12, HEADER_BYTES));
        return Buffer.concat([decipher.update(blob.subarray(HEADER_BYTES)), decipher.final()]);
      } catch {
        throw new Error("could not authenticate Linux encrypted secret");
      } finally {
        key.fill(0);
      }
    },
    async remove(name) {
      requireName(name);
      if (!requireStore(false)) return;
      const file = path.join(dir, `${name}.secret`);
      if (existingFile(file)) fs.unlinkSync(file);
    },
  };
}
