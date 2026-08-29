import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PROTOCOL_VERSION } from "@foundry-mcp/protocol";
import { createFoundryMcpServer } from "../src/server.js";
import { createStubBridgeConnection, type BridgeConnection } from "../src/bridge-connection.js";

async function setup(bridge: BridgeConnection = createStubBridgeConnection()): Promise<{
  client: Client;
  cleanup: () => Promise<void>;
}> {
  const server = createFoundryMcpServer({ bridge });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("foundry.connections.list", () => {
  it("returns an empty array with a text summary against the stub connection", async () => {
    const { client, cleanup } = await setup();
    try {
      const result = await client.callTool({ name: "foundry.connections.list", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ connections: [] });
      const content = result.content as unknown[];
      expect(Array.isArray(content)).toBe(true);
      expect(content.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it("returns an INVALID_DATA error envelope for unexpected extra arguments", async () => {
    const { client, cleanup } = await setup();
    try {
      const result = await client.callTool({
        name: "foundry.connections.list",
        arguments: { unexpected: "value" },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
      const envelope = JSON.parse(text) as { code: string };
      expect(envelope.code).toBe("INVALID_DATA");
    } finally {
      await cleanup();
    }
  });
});

describe("foundry.capabilities.get", () => {
  it("returns the protocol version and a capabilities list", async () => {
    const { client, cleanup } = await setup();
    try {
      const result = await client.callTool({ name: "foundry.capabilities.get", arguments: {} });
      expect(result.isError).not.toBe(true);
      const structured = result.structuredContent as {
        protocolVersion: string;
        capabilities: unknown[];
      };
      expect(structured.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(structured.capabilities.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });
});
