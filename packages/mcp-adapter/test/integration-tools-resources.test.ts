import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  createDatabaseMutationAuthorizer,
  openDatabase,
  runMigrations,
  setCapabilityGrant,
} from "@foundry-mcp/host";

import type { BridgeConnection } from "../src/bridge-connection.js";
import type { MutationAuthorizer } from "../src/mutation-authorization.js";
import { createFoundryMcpServer } from "../src/server.js";

const connection = {
  connectionId: "world-a",
  worldId: "alpha",
  worldTitle: "Alpha World",
  status: "connected" as const,
};
const document = {
  id: "a",
  uuid: "Actor.a",
  type: "Actor",
  name: "Hero",
  sourceHash: "hash-a",
  sourceVersion: 1,
  data: { name: "Hero", type: "hero" },
  ownershipSummary: { default: 1 },
  schemaVersion: "13",
};
const session = {
  sessionId: "session-a",
  journalUuid: "JournalEntry.j",
  title: "Game Night",
  purpose: "Play",
  tags: [],
  participants: [],
  linkedUuids: [],
  status: "open" as const,
  startedAt: "2026-08-29T12:00:00.000Z",
  updatedAt: "2026-08-29T12:00:00.000Z",
};

async function setup(bridge: BridgeConnection, mutationAuthorizer?: MutationAuthorizer) {
  const server = createFoundryMcpServer({
    bridge,
    ...(mutationAuthorizer ? { mutationAuthorizer } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "integration-test", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("document/intelligence tools and enumerable resources", () => {
  it("registers generic document and intelligence tools and enumerates foundry:// resources", async () => {
    const bridge: BridgeConnection = {
      request: (method) => {
        if (method === "connections.list") return Promise.resolve({ connections: [connection] });
        if (method === "documents.types")
          return Promise.resolve({
            types: [
              {
                type: "Actor",
                embedded: false,
                parentTypes: [],
                readable: true,
                creatable: true,
                updatable: true,
                subtypes: [],
              },
            ],
          });
        if (method === "documents.list")
          return Promise.resolve({
            items: [
              {
                id: document.id,
                uuid: document.uuid,
                type: document.type,
                name: document.name,
                sourceHash: document.sourceHash,
                sourceVersion: document.sourceVersion,
              },
            ],
          });
        if (method === "documents.get") return Promise.resolve(document);
        if (method === "sessions.list") return Promise.resolve({ sessions: [session] });
        if (method === "sessions.get") return Promise.resolve({ session, pages: [] });
        if (method === "intelligence.timeline") return Promise.resolve({ events: [] });
        if (method === "intelligence.search") return Promise.resolve({ results: [] });
        return Promise.resolve(null);
      },
      close: () => Promise.resolve(),
    };
    const context = await setup(bridge);
    try {
      const toolNames = (await context.client.listTools()).tools.map((tool) => tool.name);
      expect(toolNames).toEqual(
        expect.arrayContaining([
          "foundry.documents.types",
          "foundry.documents.list",
          "foundry.documents.get",
          "foundry.documents.create",
          "foundry.documents.update",
          "foundry.intelligence.search",
          "foundry.intelligence.timeline",
          "foundry.intelligence.changed-since",
          "foundry.intelligence.context",
        ]),
      );
      expect(
        (
          await context.client.callTool({
            name: "foundry.intelligence.search",
            arguments: { connectionId: "world-a", query: "hero" },
          })
        ).structuredContent,
      ).toEqual({ results: [] });

      const uris = (await context.client.listResources()).resources.map((resource) => resource.uri);
      expect(uris).toEqual(
        expect.arrayContaining([
          "foundry://connections",
          "foundry://world/world-a",
          "foundry://document/Actor.a",
          "foundry://session/session-a",
          "foundry://intelligence/latest",
        ]),
      );
      const read = await context.client.readResource({ uri: "foundry://document/Actor.a" });
      const content = read.contents[0];
      expect(content && "text" in content ? JSON.parse(content.text) : null).toMatchObject({
        uuid: "Actor.a",
        data: { name: "Hero" },
      });
    } finally {
      await context.close();
    }
  });
});

describe("MCP mutation policy and exactly-once audit", () => {
  let db: ReturnType<typeof openDatabase>;

  afterEach(() => db?.close());

  it("blocks before side effects, then audits one success and one denied call with redaction", async () => {
    db = openDatabase(":memory:");
    runMigrations(db);
    const request = vi.fn(async () => ({
      assetPath: "art/hero.png",
      source: "data",
      mimeType: "image/png",
      size: 100,
      collision: "created",
    }));
    const bridge: BridgeConnection = { request, close: () => Promise.resolve() };
    const authorizer = createDatabaseMutationAuthorizer(db, () => "GAMEMASTER" as const);
    const context = await setup(bridge, authorizer);
    const argumentsValue = {
      connectionId: "world-a",
      sourceId: "data",
      destinationPath: "art/hero.png",
      source: {
        kind: "file",
        path: "C:\\images\\api_key=never-log-this.png",
        mimeType: "image/png",
      },
    };
    try {
      const denied = await context.client.callTool({
        name: "foundry.assets.images.upload",
        arguments: argumentsValue,
      });
      expect(denied.isError).toBe(true);
      expect(request).not.toHaveBeenCalled();

      setCapabilityGrant(
        db,
        {
          connectionId: "world-a",
          foundryUserRole: "GAMEMASTER",
          requestedCapability: "assets:upload",
        },
        true,
      );
      const allowed = await context.client.callTool({
        name: "foundry.assets.images.upload",
        arguments: argumentsValue,
      });
      expect(allowed.isError).not.toBe(true);
      expect(request).toHaveBeenCalledOnce();

      const audit = db
        .prepare("SELECT outcome, tool, details_json FROM audit_log ORDER BY id")
        .all() as Array<{ outcome: string; tool: string; details_json: string }>;
      expect(audit.map((row) => row.outcome)).toEqual(["denied", "success"]);
      expect(audit.every((row) => row.tool === "foundry.assets.images.upload")).toBe(true);
      expect(JSON.stringify(audit)).not.toContain("never-log-this");
    } finally {
      await context.close();
    }
  });
});
