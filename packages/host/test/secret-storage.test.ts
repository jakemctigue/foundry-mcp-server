import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSecretStorage } from "../src/secrets/storage.js";
import { createLogger } from "../src/logger.js";

describe("secret storage", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcp-secrets-"));
    dirs.push(dir);
    return dir;
  }

  it("round-trips a secret through the dev fallback and warns explicitly", async () => {
    const dir = tmpDir();
    const warnings: string[] = [];
    const logger = createLogger({ sinks: [{ write: () => {} }] });
    const spyingLogger = {
      ...logger,
      warn: (message: string, fields?: Record<string, unknown>) => {
        warnings.push(message);
        logger.warn(message, fields);
      },
    };

    const storage = createSecretStorage({ dir, logger: spyingLogger, forceFallback: true });
    const secret = Buffer.from("super-secret-pairing-value");

    await storage.save("pairing", secret);
    const loaded = await storage.load("pairing");

    expect(loaded?.equals(secret)).toBe(true);
    expect(
      warnings.some((w) => w.includes("development fallback, not for production Windows use")),
    ).toBe(true);
  });

  it("returns undefined for a secret that was never saved", async () => {
    const dir = tmpDir();
    const logger = createLogger({ sinks: [{ write: () => {} }] });
    const storage = createSecretStorage({ dir, logger, forceFallback: true });
    const loaded = await storage.load("does-not-exist");
    expect(loaded).toBeUndefined();
  });

  it("uses the platform-native path (DPAPI on win32) when not forcing the fallback", async () => {
    const dir = tmpDir();
    const logger = createLogger({ sinks: [{ write: () => {} }] });
    const storage = createSecretStorage({ dir, logger });
    const secret = Buffer.from("native-path-secret");

    await storage.save("native", secret);
    const loaded = await storage.load("native");

    expect(loaded?.equals(secret)).toBe(true);
  });
});
