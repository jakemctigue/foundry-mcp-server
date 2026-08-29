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
  currentUser: { id: "gm-a", name: "Game Master", role: "GAMEMASTER" as const },
  system: { id: "dnd5e", version: "5.1.0" },
  activeModules: [{ id: "foundry-mcp", version: "0.1.0" }],
  moduleCapabilities: ["documents.read", "sessions.read", "events.publish"] as const,
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
      const capabilities = await context.client.callTool({
        name: "foundry.capabilities.get",
        arguments: {},
      });
      const listedCapabilities = (
        capabilities.structuredContent as {
          capabilities: Array<{ name: string; readOnly: boolean }>;
        }
      ).capabilities;
      expect(listedCapabilities.find(({ name }) => name === "documents")).toMatchObject({
        readOnly: false,
      });
      expect(listedCapabilities.find(({ name }) => name === "connections")).toMatchObject({
        readOnly: true,
      });
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
          "foundry://document/world-a/Actor.a",
          "foundry://session/world-a/session-a",
          "foundry://intelligence/world-a/latest",
        ]),
      );
      const read = await context.client.readResource({
        uri: "foundry://document/world-a/Actor.a",
      });
      const content = read.contents[0];
      expect(content && "text" in content ? JSON.parse(content.text) : null).toMatchObject({
        uuid: "Actor.a",
        data: { name: "Hero" },
      });
    } finally {
      await context.close();
    }
  });

  it("keeps duplicate document and session ids deterministic across encoded world ids", async () => {
    const connections = [
      { ...connection, connectionId: "world/a", worldId: "alpha", worldTitle: "Alpha" },
      { ...connection, connectionId: "world b", worldId: "beta", worldTitle: "Beta" },
    ];
    const duplicateDocument = { ...document, id: "same", uuid: "Actor.same/uuid" };
    const duplicateSession = { ...session, sessionId: "session/same" };
    const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      const connectionId = String(params.connectionId ?? "");
      if (method === "connections.list") return { connections };
      if (method === "documents.types") {
        return {
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
        };
      }
      if (method === "documents.list") {
        return {
          items: [
            {
              id: duplicateDocument.id,
              uuid: duplicateDocument.uuid,
              type: duplicateDocument.type,
              name: `${connectionId} hero`,
              sourceHash: duplicateDocument.sourceHash,
              sourceVersion: duplicateDocument.sourceVersion,
            },
          ],
        };
      }
      if (method === "documents.get") {
        return { ...duplicateDocument, name: `${connectionId} hero`, data: { connectionId } };
      }
      if (method === "sessions.list") {
        return {
          sessions: [{ ...duplicateSession, title: `${connectionId} session` }],
        };
      }
      if (method === "sessions.get") {
        return {
          session: { ...duplicateSession, title: `${connectionId} session` },
          pages: [],
        };
      }
      if (method === "intelligence.timeline") return { events: [] };
      return null;
    });
    const context = await setup({ request, close: () => Promise.resolve() });
    try {
      const uris = (await context.client.listResources()).resources.map(({ uri }) => uri);
      expect(uris).toEqual(
        expect.arrayContaining([
          "foundry://world/world%2Fa",
          "foundry://world/world%20b",
          "foundry://document/world%2Fa/Actor.same%2Fuuid",
          "foundry://document/world%20b/Actor.same%2Fuuid",
          "foundry://session/world%2Fa/session%2Fsame",
          "foundry://session/world%20b/session%2Fsame",
          "foundry://intelligence/world%2Fa/latest",
          "foundry://intelligence/world%20b/latest",
        ]),
      );
      await expect(
        context.client.readResource({ uri: "foundry://document/Actor.same%2Fuuid" }),
      ).rejects.toThrow();

      const alphaDocument = await context.client.readResource({
        uri: "foundry://document/world%2Fa/Actor.same%2Fuuid",
      });
      const betaDocument = await context.client.readResource({
        uri: "foundry://document/world%20b/Actor.same%2Fuuid",
      });
      const alphaText = alphaDocument.contents[0];
      const betaText = betaDocument.contents[0];
      expect(alphaText && "text" in alphaText ? JSON.parse(alphaText.text) : null).toMatchObject({
        data: { connectionId: "world/a" },
      });
      expect(betaText && "text" in betaText ? JSON.parse(betaText.text) : null).toMatchObject({
        data: { connectionId: "world b" },
      });

      await context.client.readResource({ uri: "foundry://session/world%2Fa/session%2Fsame" });
      await context.client.readResource({ uri: "foundry://intelligence/world%20b/latest" });
      expect(request).toHaveBeenCalledWith("documents.get", {
        connectionId: "world/a",
        uuid: "Actor.same/uuid",
      });
      expect(request).toHaveBeenCalledWith("documents.get", {
        connectionId: "world b",
        uuid: "Actor.same/uuid",
      });
      expect(request).toHaveBeenCalledWith("sessions.get", {
        connectionId: "world/a",
        sessionId: "session/same",
        pageSize: 100,
      });
      expect(request).toHaveBeenCalledWith("intelligence.timeline", {
        connectionId: "world b",
        limit: 25,
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
