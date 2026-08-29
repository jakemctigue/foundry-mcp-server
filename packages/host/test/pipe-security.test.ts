import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { connectPipeClient } from "../src/bridge/pipe-client.js";
import {
  defaultClientTokenCheck,
  encodeFrame,
  FrameDecoder,
  startPipeServer,
} from "../src/bridge/pipe-server.js";
import {
  inspectWindowsPipeDescriptor,
  resolveWindowsPipeBrokerInvocation,
} from "../src/bridge/windows-pipe-broker.js";
import { createLogger, type Logger } from "../src/logger.js";

const AUTH_KEY = Buffer.alloc(32, 0x61);

function pipePath(name: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\foundry-mcp-test-${name}-${Date.now().toString()}`;
  }
  return path.join(os.tmpdir(), `foundry-mcp-test-${name}-${Date.now().toString()}.sock`);
}

function capturedLogger(): {
  logger: Logger;
  errors: string[];
  warnings: string[];
  waitForWarning: Promise<void>;
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  let resolveWarning: (() => void) | undefined;
  const waitForWarning = new Promise<void>((resolve) => {
    resolveWarning = resolve;
  });
  const base = createLogger({ sinks: [{ write: () => {} }], level: "debug" });
  return {
    logger: {
      ...base,
      error: (message) => {
        errors.push(message);
      },
      warn: (message) => {
        warnings.push(message);
        resolveWarning?.();
      },
    },
    errors,
    warnings,
    waitForWarning,
  };
}

async function waitWithTimeout(promise: Promise<void>): Promise<void> {
  await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("security rejection timed out")), 5_000);
      timer.unref();
    }),
  ]);
}

describe("pipe security enforcement", () => {
  it("rejects a simulated mismatched client token before invoking onMessage", async () => {
    const capture = capturedLogger();
    const target = pipePath("token-mismatch");
    let messages = 0;
    const server = await startPipeServer({
      pipePath: target,
      logger: capture.logger,
      authKey: AUTH_KEY,
      clientTokenCheck: () => false,
      onMessage: () => {
        messages += 1;
      },
    });
    expect(server.ready).toBe(true);

    await expect(connectPipeClient(target, { authKey: AUTH_KEY })).rejects.toThrow(
      "bridge connection closed before authentication completed",
    );
    await waitWithTimeout(capture.waitForWarning);

    expect(messages).toBe(0);
    expect(capture.warnings.some((message) => message.includes("client token check failed"))).toBe(
      true,
    );
    await Promise.all([server.close(), server.close()]);
  });

  it("rejects a valid-token connection with an invalid HMAC before onMessage", async () => {
    const capture = capturedLogger();
    const target = pipePath("hmac-mismatch");
    let messages = 0;
    const server = await startPipeServer({
      pipePath: target,
      logger: capture.logger,
      authKey: AUTH_KEY,
      onMessage: () => {
        messages += 1;
      },
    });
    expect(server.ready).toBe(true);

    await expect(connectPipeClient(target, { authKey: Buffer.alloc(32, 0x62) })).rejects.toThrow(
      "bridge connection closed before authentication completed",
    );
    await waitWithTimeout(capture.waitForWarning);

    expect(messages).toBe(0);
    expect(capture.warnings.some((message) => message.includes("HMAC check failed"))).toBe(true);
    await Promise.all([server.close(), server.close()]);
  });

  it("fails closed before transport startup when no HMAC key is configured", async () => {
    const capture = capturedLogger();
    const server = await startPipeServer({
      pipePath: pipePath("missing-hmac"),
      logger: capture.logger,
      onMessage: () => {
        throw new Error("unreachable");
      },
    });

    expect(server.ready).toBe(false);
    expect(capture.errors.some((message) => message.includes("HMAC key is missing"))).toBe(true);
  });

  it("client fails closed when neither memory nor protected storage has an HMAC key", async () => {
    const emptyAppData = fs.mkdtempSync(path.join(os.tmpdir(), "fmcp-no-bridge-key-"));
    try {
      await expect(
        connectPipeClient(pipePath("no-client-key"), { appDataDir: emptyAppData }),
      ).rejects.toThrow(/HMAC key is unavailable/);
    } finally {
      fs.rmSync(emptyAppData, { recursive: true, force: true });
    }
  });

  it("default Windows token check requires both TokenUser and logon SID matches", async () => {
    expect(
      await defaultClientTokenCheck({
        platform: "win32",
        tokenVerified: true,
        clientUserSid: "S-1-5-21-1",
        clientLogonSid: "S-1-5-5-1-2",
        expectedUserSid: "S-1-5-21-1",
        expectedLogonSid: "S-1-5-5-1-2",
      }),
    ).toBe(true);
    expect(
      await defaultClientTokenCheck({
        platform: "win32",
        tokenVerified: true,
        clientUserSid: "S-1-5-21-999",
        clientLogonSid: "S-1-5-5-9-9",
        expectedUserSid: "S-1-5-21-1",
        expectedLogonSid: "S-1-5-5-1-2",
      }),
    ).toBe(false);
    expect(
      await defaultClientTokenCheck({
        platform: "win32",
        tokenVerified: false,
        clientUserSid: "S-1-5-21-1",
        clientLogonSid: "S-1-5-5-1-2",
        expectedUserSid: "S-1-5-21-1",
        expectedLogonSid: "S-1-5-5-1-2",
      }),
    ).toBe(false);
    expect(
      await defaultClientTokenCheck({
        platform: "win32",
        tokenVerified: true,
        clientUserSid: "S-1-5-21-1",
        clientLogonSid: "S-1-5-5-1-2",
        expectedUserSid: "S-1-5-21-1",
      }),
    ).toBe(false);
    expect(await defaultClientTokenCheck({ platform: "linux", tokenVerified: true })).toBe(true);
  });

  it("frame decoder buffers partial frames and rejects an oversized declared frame", () => {
    const encoded = encodeFrame({ hello: "world" });
    const decoder = new FrameDecoder();
    expect(decoder.push(encoded.subarray(0, 2))).toEqual([]);
    expect(decoder.push(encoded.subarray(2))).toEqual([{ hello: "world" }]);

    const oversizedHeader = Buffer.alloc(4);
    oversizedHeader.writeUInt32BE(16 * 1024 * 1024 + 1);
    expect(() => new FrameDecoder().push(oversizedHeader)).toThrow(/maximum size/);
  });

  it.skipIf(process.platform !== "win32")(
    "resolves packaged and framework-dependent broker invocations and denies missing helpers",
    () => {
      const packaged = resolveWindowsPipeBrokerInvocation();
      expect(packaged.executablePath.endsWith("foundry-mcp-pipe-broker.exe")).toBe(true);

      const frameworkDll = path.resolve(
        "native/windows-pipe-broker/bin/Release/net8.0/win-x64/foundry-mcp-pipe-broker.dll",
      );
      const viaDotnet = resolveWindowsPipeBrokerInvocation(frameworkDll);
      expect(viaDotnet.command).toBe("dotnet");
      expect(viaDotnet.prefixArgs).toEqual([frameworkDll]);
      expect(() =>
        resolveWindowsPipeBrokerInvocation(path.resolve("native/does-not-exist.exe")),
      ).toThrow(/was not found/);

      const originalArchitecture = process.arch;
      Object.defineProperty(process, "arch", { value: "ia32", configurable: true });
      try {
        expect(() => resolveWindowsPipeBrokerInvocation()).toThrow(/unsupported.*architecture/);
      } finally {
        Object.defineProperty(process, "arch", {
          value: originalArchitecture,
          configurable: true,
        });
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "live Windows descriptor probe rejects a non-matching expected logon SID",
    async () => {
      const target = pipePath("descriptor-mismatch");
      const logger = createLogger({ sinks: [{ write: () => {} }], level: "error" });
      const server = await startPipeServer({
        pipePath: target,
        logger,
        authKey: AUTH_KEY,
        onMessage: () => {},
      });
      expect(server.ready).toBe(true);

      const accepted = await inspectWindowsPipeDescriptor(target, {
        expectedLogonSid: "S-1-5-5-999999-999999",
      });
      expect(accepted).toBe(false);
      const wrongOwnerAccepted = await inspectWindowsPipeDescriptor(target, {
        expectedUserSid: "S-1-5-21-999999-999999-999999-999999",
      });
      expect(wrongOwnerAccepted).toBe(false);
      await server.close();
    },
  );
});
