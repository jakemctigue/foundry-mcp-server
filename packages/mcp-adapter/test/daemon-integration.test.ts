import { describe, expect, it, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectPipeClient, startDaemon, type Daemon, type PipeClient } from "@foundry-mcp/host";
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
      companionPairingSecret: Buffer.alloc(32, 0x5a),
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

    await expect(connectNegotiatedBridge("test-pipe", { connect, negotiate })).rejects.toThrow(
      "bridge authentication/version failure",
    );
    expect(connect).toHaveBeenCalledWith("test-pipe");
    expect(close).toHaveBeenCalledOnce();
  });

  it("bounds a silent bridge negotiation and closes the connection", async () => {
    const close = vi.fn(async () => undefined);
    const bridge: BridgeConnection = {
      request: vi.fn(() => new Promise(() => undefined)),
      close,
    };

    await expect(
      connectNegotiatedBridge("silent-pipe", {
        connect: async () => bridge,
        negotiateTimeoutMs: 10,
      }),
    ).rejects.toThrow("bridge negotiation timed out");
    expect(close).toHaveBeenCalledOnce();
  });

  it("bounds daemon requests that never receive a response", async () => {
    const client: PipeClient = {
      send: vi.fn(),
      onMessage: vi.fn(),
      onError: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const bridge = await connectToDaemon("silent-pipe", {
      connectPipeClient: async () => client,
      requestTimeoutMs: 10,
    });

    await expect(bridge.request("initialize")).rejects.toThrow(
      "bridge request initialize timed out",
    );
    await bridge.close();
  });

  it("rejects quickly when the real broker child closes an invalid-HMAC client", async () => {
    appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcp-adapter-bad-hmac-"));
    daemon = await startDaemon({
      appDataDir,
      cliConfig: { dbPath: "bad-hmac.db", pipeName: path.basename(appDataDir) },
      companionPairingSecret: Buffer.alloc(32, 0x5a),
    });
    expect(daemon.pipe.ready).toBe(true);

    await expect(
      connectToDaemon(daemon.pipePath, {
        connectPipeClient: (pipePath) =>
          connectPipeClient(pipePath, { authKey: Buffer.alloc(32, 0xa5) }),
        requestTimeoutMs: 2_000,
      }),
    ).rejects.toThrow("bridge connection closed before authentication completed");
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
