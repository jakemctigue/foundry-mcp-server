import { describe, expect, it, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDaemon, type Daemon } from "@foundry-mcp/host";
import { BRIDGE_PROTOCOL_VERSION } from "@foundry-mcp/protocol";
import {
  connectNegotiatedBridge,
  connectToDaemon,
  negotiateProtocolVersion,
  type BridgeConnection,
} from "../src/bridge-connection.js";

describe("mcp-adapter <-> real host daemon", () => {
  let daemon: Daemon | undefined;
  let appDataDir: string | undefined;

  afterEach(async () => {
    await daemon?.shutdown();
    if (appDataDir) {
      fs.rmSync(appDataDir, { recursive: true, force: true });
    }
    daemon = undefined;
    appDataDir = undefined;
  });

  it("connects over the named pipe and negotiates the bridge protocol version", async () => {
    appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcp-adapter-it-"));
    daemon = await startDaemon({
      appDataDir,
      cliConfig: { dbPath: "test.db", pipeName: "foundry-mcp-daemon-integration" },
    });
    expect(daemon.pipe.ready).toBe(true);

    const bridge = await connectToDaemon(daemon.pipePath);
    const negotiated = await negotiateProtocolVersion(bridge);
    expect(negotiated.protocolVersion).toBe(BRIDGE_PROTOCOL_VERSION);

    const listResult = (await bridge.request("connections.list")) as { connections: unknown[] };
    expect(listResult.connections).toEqual([]);

    await bridge.close();
  });

  it("fails closed and closes an opened bridge when negotiation fails", async () => {
    const close = vi.fn(async () => undefined);
    const bridge: BridgeConnection = {
      request: vi.fn(async () => null),
      close,
    };
    const connect = vi.fn(async () => bridge);
    const negotiate = vi.fn(async () => {
      throw new Error("bridge authentication/version failure");
    });

    await expect(
      connectNegotiatedBridge("test-pipe", { connect, negotiate }),
    ).rejects.toThrow("bridge authentication/version failure");
    expect(connect).toHaveBeenCalledWith("test-pipe");
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not substitute a stub when the daemon connection fails", async () => {
    const connect = vi.fn(async () => {
      throw new Error("daemon unavailable");
    });
    await expect(connectNegotiatedBridge("missing-pipe", { connect })).rejects.toThrow(
      "daemon unavailable",
    );
  });
});
