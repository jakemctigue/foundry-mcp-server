import { describe, expect, it, vi } from "vitest";

import type { BridgeConnection } from "../src/bridge-connection.js";
import { runAdapterCli } from "../src/cli.js";

function processFixture() {
  const handlers = new Map<string, () => void>();
  const runtimeProcess = {
    exitCode: undefined as number | undefined,
    once: vi.fn((event: string, listener: () => void) => {
      handlers.set(event, listener);
    }),
    stdin: {
      once: vi.fn((event: string, listener: () => void) => {
        handlers.set(`stdin:${event}`, listener);
      }),
    },
    stderr: { write: vi.fn() },
  };
  return { handlers, runtimeProcess };
}

function bridgeFixture(close: () => Promise<void>): BridgeConnection {
  return { request: vi.fn(async () => null), close };
}

describe("adapter CLI lifecycle", () => {
  it("always closes the bridge and reports every shutdown failure", async () => {
    const closeStdio = vi.fn(async () => {
      throw new Error("stdio close failed");
    });
    const closeBridge = vi.fn(async () => {
      throw new Error("bridge close failed");
    });
    const { runtimeProcess } = processFixture();
    const lifecycle = await runAdapterCli({
      bridgeFactory: async () => bridgeFixture(closeBridge),
      serverFactory: () => ({}) as never,
      serve: () => ({ close: closeStdio }),
      runtimeProcess,
    });

    await expect(lifecycle.shutdown()).rejects.toMatchObject({
      name: "AggregateError",
      errors: [
        expect.objectContaining({ message: "stdio close failed" }),
        expect.objectContaining({ message: "bridge close failed" }),
      ],
    });
    expect(closeStdio).toHaveBeenCalledOnce();
    expect(closeBridge).toHaveBeenCalledOnce();
  });

  it("catches signal-triggered shutdown failures and sets a failing exit code", async () => {
    const closeStdio = vi.fn(async () => {
      throw new Error("signal cleanup failed");
    });
    const closeBridge = vi.fn(async () => undefined);
    const { handlers, runtimeProcess } = processFixture();
    const lifecycle = await runAdapterCli({
      bridgeFactory: async () => bridgeFixture(closeBridge),
      serverFactory: () => ({}) as never,
      serve: () => ({ close: closeStdio }),
      runtimeProcess,
    });

    handlers.get("SIGINT")?.();
    await expect(lifecycle.shutdown()).rejects.toThrow("adapter shutdown failed");
    await vi.waitFor(() => expect(runtimeProcess.exitCode).toBe(1));
    expect(runtimeProcess.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("shutdown failed"),
    );
    expect(handlers.has("SIGTERM")).toBe(true);
    expect(handlers.has("stdin:end")).toBe(true);
  });

  it("treats stdio transport errors as fatal and cleans up both transports", async () => {
    const closeStdio = vi.fn(async () => undefined);
    const closeBridge = vi.fn(async () => undefined);
    const { runtimeProcess } = processFixture();
    let onerror: ((error: Error) => void) | undefined;
    const lifecycle = await runAdapterCli({
      bridgeFactory: async () => bridgeFixture(closeBridge),
      serverFactory: () => ({}) as never,
      serve: (_factory, options) => {
        onerror = options.onerror;
        return { close: closeStdio };
      },
      runtimeProcess,
    });

    onerror?.(new Error("stdio transport failed"));
    await lifecycle.shutdown();
    expect(runtimeProcess.exitCode).toBe(1);
    expect(runtimeProcess.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("stdio transport failed"),
    );
    expect(closeStdio).toHaveBeenCalledOnce();
    expect(closeBridge).toHaveBeenCalledOnce();
  });
});
