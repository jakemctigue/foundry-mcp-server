import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createFoundryMcpServer } from "../src/server.js";
import type { BridgeConnection } from "../src/bridge-connection.js";
import type { MutationAuthorizer } from "../src/mutation-authorization.js";

const allowMutations: MutationAuthorizer = {
  run: async (_request, operation) => operation(),
};

async function setup(
  bridge: BridgeConnection,
): Promise<{ client: Client; close(): Promise<void> }> {
  const server = createFoundryMcpServer({ bridge, mutationAuthorizer: allowMutations });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "asset-test-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("asset and session MCP tool registration", () => {
  it("registers the complete runtime-backed tool surface", async () => {
    const bridge: BridgeConnection = {
      request: () => Promise.resolve(null),
      close: () => Promise.resolve(),
    };
    const context = await setup(bridge);
    try {
      const names = (await context.client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "foundry.assets.images.list",
          "foundry.assets.references.find",
          "foundry.assets.images.upload",
          "foundry.assets.images.generate",
          "foundry.assets.images.attach",
          "foundry.sessions.start",
          "foundry.sessions.append",
          "foundry.sessions.list",
          "foundry.sessions.get",
          "foundry.sessions.end",
          "foundry.sessions.reopen",
        ]),
      );
    } finally {
      await context.close();
    }
  });

  it("forwards parsed defaults and returns structured bridge output", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const bridge: BridgeConnection = {
      request: (method, params) => {
        calls.push({ method, ...(params ? { params } : {}) });
        if (method === "assets.images.generate") {
          return Promise.resolve({
            assetPath: "generated/token.png",
            source: "data",
            mimeType: "image/png",
            size: 100,
            collision: "created",
            provider: "deterministic",
            model: "deterministic-sha256-v1",
          });
        }
        if (method === "sessions.list") return Promise.resolve({ sessions: [] });
        return Promise.resolve(null);
      },
      close: () => Promise.resolve(),
    };
    const context = await setup(bridge);
    try {
      const generated = await context.client.callTool({
        name: "foundry.assets.images.generate",
        arguments: {
          connectionId: "world-a",
          prompt: "A rune",
          destinationPath: "generated/token.png",
        },
      });
      expect(generated.isError).not.toBe(true);
      expect(generated.structuredContent).toMatchObject({ provider: "deterministic" });
      expect(calls[0]).toMatchObject({
        method: "assets.images.generate",
        params: {
          provider: "deterministic",
          connectionId: "world-a",
          sourceId: "data",
          onCollision: "error",
          options: {},
        },
      });
      expect(
        (
          await context.client.callTool({
            name: "foundry.sessions.list",
            arguments: {},
          })
        ).structuredContent,
      ).toEqual({ sessions: [] });
    } finally {
      await context.close();
    }
  });
});
