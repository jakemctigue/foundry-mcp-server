import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/client";
import { LEGACY_MCP_PROTOCOL_VERSIONS } from "@foundry-mcp/protocol";
import { CapturingChildStdioTransport } from "./child-stdio-transport.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(packageDir, "dist", "cli.js");

function waitForResponse(
  transport: CapturingChildStdioTransport,
  id: number,
  timeoutMs = 5000,
): Promise<JSONRPCMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`timed out waiting for JSON-RPC response ${id.toString()}`)),
      timeoutMs,
    );
    transport.onmessage = (message) => {
      if ("id" in message && message.id === id) {
        clearTimeout(timeout);
        resolve(message);
      }
    };
  });
}

describe.each([...LEGACY_MCP_PROTOCOL_VERSIONS])("legacy MCP initialize %s", (protocolVersion) => {
  it("initializes, lists tools, emits only protocol frames, and exits cleanly", async () => {
    const transport = new CapturingChildStdioTransport(cliEntry, packageDir);
    await transport.start();

    try {
      const initialized = waitForResponse(transport, 1);
      await transport.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "foundry-mcp-legacy-conformance", version: "0.0.1" },
        },
      });
      const initializeResponse = await initialized;
      expect(initializeResponse).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion },
      });

      await transport.send({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });

      const listed = waitForResponse(transport, 2);
      await transport.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      const listResponse = await listed;
      expect(listResponse).toMatchObject({ jsonrpc: "2.0", id: 2 });
      if (!("result" in listResponse)) throw new Error("tools/list did not return a result");
      const names = (listResponse.result as { tools: Array<{ name: string }> }).tools.map(
        ({ name }) => name,
      );
      expect(names).toEqual(
        expect.arrayContaining(["foundry.connections.list", "foundry.capabilities.get"]),
      );
    } finally {
      await transport.close();
    }

    expect(await transport.waitForExit()).toEqual({ code: 0, signal: null });
    expect(transport.stdoutLines.length).toBeGreaterThanOrEqual(2);
    expect(transport.protocolErrors).toEqual([]);
    expect(transport.stderrText).toBe("");
    for (const line of transport.stdoutLines) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    }
  }, 20000);
});
