import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import {
  BRIDGE_PROTOCOL_VERSION,
  LEGACY_MCP_PROTOCOL_VERSIONS,
  MCP_PROTOCOL_VERSION,
} from "@foundry-mcp/protocol";
import { CapturingChildStdioTransport } from "./child-stdio-transport.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(packageDir, "dist", "cli.js");

describe("modern MCP negotiation against the built adapter", () => {
  let client: Client | undefined;
  let transport: CapturingChildStdioTransport | undefined;

  afterEach(async () => {
    await client?.close();
    await transport?.close();
    client = undefined;
    transport = undefined;
  });

  it("pins 2026-07-28, calls representative tools, and keeps stdout protocol-only", async () => {
    transport = new CapturingChildStdioTransport(cliEntry, packageDir);
    client = new Client(
      { name: "foundry-mcp-modern-conformance", version: "0.0.1" },
      { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
    );

    await client.connect(transport);

    expect(client.getNegotiatedProtocolVersion()).toBe(MCP_PROTOCOL_VERSION);
    expect(client.getProtocolEra()).toBe("modern");

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["foundry.connections.list", "foundry.capabilities.get"]),
    );

    const progress: Array<{
      progress: number;
      total?: number | undefined;
      message?: string | undefined;
    }> = [];
    const connections = await client.callTool(
      {
        name: "foundry.connections.list",
        arguments: {},
      },
      { onprogress: (update) => progress.push(update) },
    );
    expect(connections.isError).not.toBe(true);
    expect(connections.structuredContent).toEqual({ connections: [] });
    await vi.waitFor(() => expect(progress).toHaveLength(2));
    expect(progress).toEqual([
      expect.objectContaining({ progress: 0, total: 1_000 }),
      expect.objectContaining({ progress: 1_000, total: 1_000 }),
    ]);

    const capabilities = await client.callTool({
      name: "foundry.capabilities.get",
      arguments: {},
    });
    expect(capabilities.isError).not.toBe(true);
    expect(capabilities.structuredContent).toMatchObject({
      mcpProtocolVersion: MCP_PROTOCOL_VERSION,
      legacyMcpProtocolVersions: LEGACY_MCP_PROTOCOL_VERSIONS,
      bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
    });

    await client.close();
    client = undefined;
    const exit = await transport.waitForExit();

    expect(exit).toEqual({ code: 0, signal: null });
    expect(transport.stdoutLines.length).toBeGreaterThan(0);
    expect(transport.protocolErrors).toEqual([]);
    expect(transport.stderrText).toBe("");
    for (const line of transport.stdoutLines) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    }
  }, 20000);

  it("fails loudly when the requested modern revision is unsupported", async () => {
    transport = new CapturingChildStdioTransport(cliEntry, packageDir);
    client = new Client(
      { name: "foundry-mcp-bad-pin", version: "0.0.1" },
      { versionNegotiation: { mode: { pin: "2099-01-01" } } },
    );

    await expect(client.connect(transport)).rejects.toBeTruthy();
  }, 20000);
});
