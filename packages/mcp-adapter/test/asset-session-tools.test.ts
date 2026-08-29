import { describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createFoundryMcpServer } from "../src/server.js";
import type { BridgeConnection } from "../src/bridge-connection.js";
import type { MutationAuthorizer } from "../src/mutation-authorization.js";

const allowMutations: MutationAuthorizer = {
  run: async (_request, operation) => operation(),
};

async function setup(
  bridge: BridgeConnection,
  mutationAuthorizer: MutationAuthorizer = allowMutations,
): Promise<{ client: Client; close(): Promise<void> }> {
  const server = createFoundryMcpServer({ bridge, mutationAuthorizer });
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

  it("requires ai:network authorization before forwarding external image generation", async () => {
    const request = vi.fn(async () => ({
      assetPath: "generated/token.png",
      source: "data",
      mimeType: "image/png",
      size: 100,
      collision: "created" as const,
      provider: "deterministic",
    }));
    const bridge: BridgeConnection = {
      request,
      close: () => Promise.resolve(),
    };
    const authorizations: Parameters<MutationAuthorizer["run"]>[0][] = [];
    const authorizer: MutationAuthorizer = {
      run: async (authorization, operation) => {
        authorizations.push(authorization);
        if (authorization.additionalCapabilities?.includes("ai:network")) {
          throw {
            message: "Permission denied: missing capability ai:network",
            missingCapability: "ai:network",
            connectionId: authorization.connectionId,
          };
        }
        return operation();
      },
    };
    const context = await setup(bridge, authorizer);
    try {
      const denied = await context.client.callTool({
        name: "foundry.assets.images.generate",
        arguments: {
          connectionId: "world-a",
          prompt: "A network rune",
          provider: "openai",
          destinationPath: "generated/network.png",
        },
      });
      expect(denied.isError).toBe(true);
      expect(denied.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining("ai:network") }),
        ]),
      );
      expect(request).not.toHaveBeenCalled();
      expect(authorizations[0]).toMatchObject({
        requestedCapability: "assets:upload",
        additionalCapabilities: ["ai:network"],
      });

      const local = await context.client.callTool({
        name: "foundry.assets.images.generate",
        arguments: {
          connectionId: "world-a",
          prompt: "A local rune",
          provider: "deterministic",
          destinationPath: "generated/local.png",
        },
      });
      expect(local.isError).not.toBe(true);
      expect(request).toHaveBeenCalledOnce();
      expect(authorizations[1]).toMatchObject({ requestedCapability: "assets:upload" });
      expect(authorizations[1]?.additionalCapabilities).toBeUndefined();
    } finally {
      await context.close();
    }
  });

  it("forwards opaque session cursors unchanged and rejects unsafe legacy offsets", async () => {
    const opaqueCursor = "sc1.eyJrZXkiOiJ2YWx1ZSJ9.1234abcd";
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const bridge: BridgeConnection = {
      request: (method, params) => {
        calls.push({ method, ...(params ? { params } : {}) });
        return Promise.resolve({ sessions: [], nextCursor: opaqueCursor });
      },
      close: () => Promise.resolve(),
    };
    const context = await setup(bridge);
    try {
      const listed = await context.client.callTool({
        name: "foundry.sessions.list",
        arguments: { cursor: opaqueCursor, pageSize: 7 },
      });
      expect(listed.isError).not.toBe(true);
      expect(listed.structuredContent).toEqual({ sessions: [], nextCursor: opaqueCursor });
      expect(calls).toEqual([
        {
          method: "sessions.list",
          params: { cursor: opaqueCursor, pageSize: 7 },
        },
      ]);

      const rejected = await context.client.callTool({
        name: "foundry.sessions.list",
        arguments: { cursor: "v1.2" },
      });
      expect(rejected.isError).toBe(true);
      expect(calls).toHaveLength(1);
    } finally {
      await context.close();
    }
  });
});
