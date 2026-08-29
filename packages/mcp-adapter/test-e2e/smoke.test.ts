import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { BRIDGE_PROTOCOL_VERSION } from "@foundry-mcp/protocol";
import { startDaemon, type Daemon } from "@foundry-mcp/host";
import {
  connectToDaemon,
  negotiateProtocolVersion,
  type BridgeConnection,
} from "../src/bridge-connection.js";
import { createFoundryMcpServer } from "../src/server.js";

describe("end-to-end smoke: adapter boots, lists zero connections", () => {
  let daemon: Daemon | undefined;
  let bridge: BridgeConnection | undefined;
  let appDataDir: string | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await bridge?.close();
    await daemon?.shutdown();
    if (appDataDir) {
      fs.rmSync(appDataDir, { recursive: true, force: true });
    }
    daemon = undefined;
    bridge = undefined;
    appDataDir = undefined;
    client = undefined;
  });

  it("performs the initialize handshake and returns zero connections with no hanging handles", async () => {
    // Real host daemon: real SQLite, real named-pipe/socket bridge listener.
    appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcp-e2e-"));
    daemon = await startDaemon({ appDataDir, cliConfig: { dbPath: "e2e.db" } });
    expect(daemon.pipe.ready).toBe(true);

    // Real mcp-adapter bridge connection over the real named pipe.
    bridge = await connectToDaemon(daemon.pipePath);
    const negotiated = await negotiateProtocolVersion(bridge);
    expect(negotiated.protocolVersion).toBe(BRIDGE_PROTOCOL_VERSION);

    // Real MCP server wired against the real bridge; MCP client<->server
    // transport is in-memory (equivalent wiring to stdio, no separate process
    // needed for the test harness).
    const server = createFoundryMcpServer({ bridge });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "e2e-client", version: "0.0.1" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: "foundry.connections.list", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ connections: [] });

    await server.close();
  });
});
