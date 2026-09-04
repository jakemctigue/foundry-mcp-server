import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSecretStorage, writeLinuxPairingCode } from "../src/secrets/storage.js";
import { loadExistingBridgeAuthKey, loadOrCreateBridgeAuthKey } from "../src/bridge/bridge-auth.js";
import { loadOpenAiImagesApiKey, saveOpenAiImagesApiKey } from "../src/secrets/image-provider.js";
import { base32Decode } from "../src/secrets/pairing.js";

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const environmentKey = "FOUNDRY_MCP_SECRET_KEY_FILE";

describe.skipIf(process.platform !== "linux")("Linux production secret storage", () => {
  let root: string;
  let keyFile: string;
  let dir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fmcp-linux-secrets-"));
    keyFile = path.join(root, "master.key");
    dir = path.join(root, "app", "secrets");
    fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(environmentKey, keyFile);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("round trips pairing and provider credentials without fallback or plaintext", async () => {
    const warning = vi.spyOn(logger, "warn");
    const storage = createSecretStorage({ dir, logger });
    const pairing = crypto.randomBytes(32);
    await storage.save("pairing", pairing);
    await saveOpenAiImagesApiKey(storage, "test-provider-credential");
    const reopened = createSecretStorage({ dir, logger });
    expect(await reopened.load("pairing")).toEqual(pairing);
    expect(await loadOpenAiImagesApiKey(reopened)).toBe("test-provider-credential");
    expect(fs.readFileSync(path.join(dir, "pairing.secret")).includes(pairing)).toBe(false);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, "pairing.secret")).mode & 0o777).toBe(0o600);
    expect(warning).not.toHaveBeenCalled();
    await reopened.remove?.("pairing");
    expect(await reopened.load("pairing")).toBeUndefined();
  });

  it("persists the same bridge HMAC key for the host and a separately created adapter", async () => {
    const appDataDir = path.dirname(dir);
    const created = await loadOrCreateBridgeAuthKey(appDataDir, logger);
    expect(await loadExistingBridgeAuthKey(appDataDir)).toEqual(created);
    expect(await loadOrCreateBridgeAuthKey(appDataDir, logger)).toEqual(created);
  });

  it("starts the production daemon using persisted pairing without an in-memory secret override", async () => {
    const appDataDir = path.dirname(dir);
    await writeLinuxPairingCode({ appDataDir, outputFile: path.join(root, "daemon-code.txt") });
    const { startDaemon } = await import("../src/daemon.js");
    const daemon = await startDaemon({ appDataDir, cliConfig: { port: 0, logLevel: "error" } });
    try {
      expect(daemon.pipe.ready).toBe(true);
      expect(daemon.companionEndpoint).toMatch(/^ws:\/\/127\.0\.0\.1:/);
      expect((await loadExistingBridgeAuthKey(appDataDir))?.length).toBe(32);
    } finally {
      await daemon.shutdown();
    }
  });

  it("authenticates the secret name as well as the encrypted bytes", async () => {
    const storage = createSecretStorage({ dir, logger });
    await storage.save("pairing", Buffer.from("private"));
    fs.copyFileSync(path.join(dir, "pairing.secret"), path.join(dir, "bridge-auth.secret"));
    await expect(storage.load("bridge-auth")).rejects.toThrow(/authenticate/);
    const blob = fs.readFileSync(path.join(dir, "pairing.secret"));
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 1;
    fs.writeFileSync(path.join(dir, "pairing.secret"), blob);
    await expect(storage.load("pairing")).rejects.toThrow(/authenticate/);
  });

  it("refuses incorrect keys and never interprets development ciphertext as production", async () => {
    const storage = createSecretStorage({ dir, logger });
    await storage.save("pairing", Buffer.from("private"));
    fs.writeFileSync(keyFile, crypto.randomBytes(32));
    await expect(createSecretStorage({ dir, logger }).load("pairing")).rejects.toThrow(
      /authenticate/,
    );
    fs.writeFileSync(path.join(dir, "pairing.secret"), Buffer.alloc(32));
    await expect(storage.load("pairing")).rejects.toThrow(/format/);
  });

  it.each([0o644, 0o640, 0o666])("refuses exposed master-key mode %i", (mode) => {
    fs.chmodSync(keyFile, mode);
    expect(() => createSecretStorage({ dir, logger })).toThrow(/master key/);
  });

  it.each([0, 31, 33, 65])("refuses a master key with %i bytes", (size) => {
    fs.writeFileSync(keyFile, Buffer.alloc(size));
    expect(() => createSecretStorage({ dir, logger })).toThrow(/master key/);
  });

  it("refuses empty, relative, missing, and colocated key files", () => {
    for (const value of ["", "relative.key", path.join(root, "missing.key")]) {
      vi.stubEnv(environmentKey, value);
      expect(() => createSecretStorage({ dir, logger })).toThrow();
    }
    vi.stubEnv(environmentKey, keyFile);
    expect(() => createSecretStorage({ dir: root, logger })).toThrow(/outside/);
  });

  it("refuses symlinks, hardlinks, and untrusted writable parent directories", () => {
    const link = path.join(root, "linked.key");
    fs.symlinkSync(keyFile, link);
    vi.stubEnv(environmentKey, link);
    expect(() => createSecretStorage({ dir, logger })).toThrow();
    fs.unlinkSync(link);
    fs.linkSync(keyFile, link);
    vi.stubEnv(environmentKey, keyFile);
    expect(() => createSecretStorage({ dir, logger })).toThrow(/master key/);
    fs.unlinkSync(link);
    fs.chmodSync(root, 0o777);
    expect(() => createSecretStorage({ dir, logger })).toThrow(/directory/);
    fs.chmodSync(root, 0o700);
  });

  it("refuses exposed store directories and symlinked secret files", async () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    const storage = createSecretStorage({ dir, logger });
    await expect(storage.save("pairing", Buffer.from("private"))).rejects.toThrow(/directory/);
    fs.chmodSync(dir, 0o700);
    fs.symlinkSync(keyFile, path.join(dir, "pairing.secret"));
    await expect(storage.load("pairing")).rejects.toThrow();
    await expect(storage.save("pairing", Buffer.from("private"))).rejects.toThrow();
    await expect(storage.remove?.("pairing")).rejects.toThrow();
    expect(fs.statSync(keyFile).size).toBe(32);
  });

  it.each(["../escape", "/absolute", "with/slash", "back\\slash", "", "..", "x\0y"])(
    "rejects invalid secret names before filesystem access: %j",
    async (name) => {
      const storage = createSecretStorage({ dir, logger });
      await expect(storage.save(name, Buffer.from("private"))).rejects.toThrow(/name/);
      await expect(storage.load(name)).rejects.toThrow(/name/);
      await expect(storage.remove?.(name)).rejects.toThrow(/name/);
    },
  );

  it("still refuses a production fallback when no independent master key is configured", async () => {
    vi.stubEnv(environmentKey, undefined);
    await expect(
      createSecretStorage({ dir, logger, allowDevelopmentFallback: true }).save(
        "pairing",
        Buffer.from("private"),
      ),
    ).rejects.toThrow(/development opt-in/);
  });

  it("bootstraps pairing to an exclusive private file, preserving it on subsequent runs", async () => {
    const first = path.join(root, "pairing-code.txt");
    const second = path.join(root, "recovered-code.txt");
    await writeLinuxPairingCode({ appDataDir: path.dirname(dir), outputFile: first });
    const raw = await createSecretStorage({ dir, logger }).load("pairing");
    expect(base32Decode(fs.readFileSync(first, "utf8").trim())).toEqual(raw);
    expect(fs.statSync(first).mode & 0o777).toBe(0o600);
    await expect(
      writeLinuxPairingCode({ appDataDir: path.dirname(dir), outputFile: first }),
    ).rejects.toThrow();
    await writeLinuxPairingCode({ appDataDir: path.dirname(dir), outputFile: second });
    expect(fs.readFileSync(second, "utf8")).toBe(fs.readFileSync(first, "utf8"));
  });

  it("refuses public pairing output directories and cleans failed bootstrap output", async () => {
    const publicDir = path.join(root, "public");
    fs.mkdirSync(publicDir, { mode: 0o755 });
    await expect(
      writeLinuxPairingCode({
        appDataDir: path.dirname(dir),
        outputFile: path.join(publicDir, "pairing.txt"),
      }),
    ).rejects.toThrow(/owner-only/);
    const storage = createSecretStorage({ dir, logger });
    await storage.save("pairing", Buffer.alloc(1));
    const output = path.join(root, "failed-code.txt");
    await expect(
      writeLinuxPairingCode({ appDataDir: path.dirname(dir), outputFile: output }),
    ).rejects.toThrow(/exactly 32/);
    expect(fs.existsSync(output)).toBe(false);
  });

  it("rejects a simulated untrusted owner in the POSIX master-key fstat metadata", async () => {
    const storage = createSecretStorage({ dir, logger });
    await storage.save("pairing", Buffer.from("private"));
    // Non-root CI cannot chown; a real fstat result is retained except the attacker uid.
    const original = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation((...args) => {
      const stat = original(...args);
      Object.defineProperty(stat, "uid", { value: 2_000_000_001 });
      return stat;
    });
    expect(() => createSecretStorage({ dir, logger })).toThrow(/master key/);
  });
});

it.skipIf(process.platform === "linux")(
  "does not silently replace Windows DPAPI with a Linux key file",
  () => {
    vi.stubEnv(environmentKey, "/not/a/windows/key");
    try {
      expect(() => createSecretStorage({ dir: os.tmpdir(), logger })).toThrow(/Linux/);
    } finally {
      vi.unstubAllEnvs();
    }
  },
);
