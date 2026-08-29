import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { startPipeServer } from "../src/bridge/pipe-server.js";
import { connectPipeClient } from "../src/bridge/pipe-client.js";
import { createLogger, stderrSink } from "../src/logger.js";
import { userSidHash, resolvePipePath, defaultUserIdentifier } from "../src/bridge/pipe-path.js";

const AUTH_KEY = Buffer.alloc(32, 0x42);

function testPipePath(name: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\foundry-mcp-test-${name}`;
  }
  return path.join(os.tmpdir(), `foundry-mcp-test-${name}.sock`);
}

describe("named pipe bridge", () => {
  it("accepts a connection and round-trips a framed JSON message", async () => {
    const logger = createLogger({ sinks: [stderrSink()], level: "error" });
    const pipePath = testPipePath(`roundtrip-${Date.now()}`);

    const server = await startPipeServer({
      pipePath,
      logger,
      authKey: AUTH_KEY,
      onMessage: (message, respond) => {
        respond({ echo: message });
      },
    });
    expect(server.ready).toBe(true);

    // In-process integration resolves the same registered key that separate
    // production processes load from the per-user protected secret store.
    const client = await connectPipeClient(pipePath);
    const received = await new Promise((resolve) => {
      client.onMessage(resolve);
      client.send({ hello: "world" });
    });

    expect(received).toEqual({ echo: { hello: "world" } });

    await client.close();
    await server.close();
  });

  it("refuses to be ready when the ACL check fails", async () => {
    const logger = createLogger({ sinks: [stderrSink()], level: "error" });
    const errors: string[] = [];
    const spyingLogger = {
      ...logger,
      error: (message: string, fields?: Record<string, unknown>) => {
        errors.push(message);
        logger.error(message, fields);
      },
    };

    const pipePath = testPipePath(`acl-fail-${Date.now()}`);
    const server = await startPipeServer({
      pipePath,
      logger: spyingLogger,
      authKey: AUTH_KEY,
      aclCheck: () => Promise.resolve(false),
      onMessage: () => {
        /* unreachable */
      },
    });

    expect(server.ready).toBe(false);
    expect(errors.some((m) => m.includes("ACL check failed"))).toBe(true);
  });

  it("derives a deterministic pipe path from the user identifier", () => {
    const hash1 = userSidHash("alice");
    const hash2 = userSidHash("alice");
    const hash3 = userSidHash("bob");
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);

    const p = resolvePipePath("alice", os.tmpdir(), "win32");
    expect(p).toBe(`\\\\.\\pipe\\foundry-mcp-${hash1}`);
  });

  it("resolves a Unix domain socket path under the app-data dir on non-Windows", () => {
    const dir = os.tmpdir();
    const p = resolvePipePath("alice", dir, "linux");
    expect(p).toBe(path.join(dir, `foundry-mcp-${userSidHash("alice")}.sock`));
  });

  it("defaultUserIdentifier returns the current OS username", () => {
    expect(typeof defaultUserIdentifier()).toBe("string");
    expect(defaultUserIdentifier().length).toBeGreaterThan(0);
  });
});
