import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";
import {
  ConnectionsListOutput,
  DocumentsGetOutput,
  DocumentsListOutput,
  DocumentsTypesOutput,
  SessionsGetOutput,
  SessionsListOutput,
} from "@foundry-mcp/protocol";

import type { BridgeConnection } from "./bridge-connection.js";
import { IntelligenceBridgeApi } from "./intelligence-api.js";
import { requestBridgeValue } from "./tools/bridge-tool.js";

const JSON_RESOURCE = {
  mimeType: "application/json",
  description: "A bounded JSON view from the same Foundry MCP business logic as the tools.",
};

function textResource(uri: URL, value: unknown) {
  return {
    contents: [
      { uri: uri.href, mimeType: "application/json" as const, text: JSON.stringify(value) },
    ],
  };
}

function variable(value: string | string[] | undefined): string {
  if (value === undefined) throw new Error("required resource URI variable is missing");
  return decodeURIComponent(Array.isArray(value) ? (value[0] ?? "") : value);
}

async function connections(bridge: BridgeConnection) {
  return requestBridgeValue(bridge, "connections.list", {}, ConnectionsListOutput);
}

async function enumerableDocuments(bridge: BridgeConnection) {
  const listedConnections = await connections(bridge);
  const resources: Array<{ uri: string; name: string; description: string; mimeType: string }> = [];
  for (const connection of listedConnections.connections) {
    const types = await requestBridgeValue(
      bridge,
      "documents.types",
      { connectionId: connection.connectionId },
      DocumentsTypesOutput,
    );
    for (const type of types.types.filter((entry) => entry.readable && !entry.embedded)) {
      if (resources.length >= 500) break;
      const page = await requestBridgeValue(
        bridge,
        "documents.list",
        { connectionId: connection.connectionId, type: type.type, pageSize: 50 },
        DocumentsListOutput,
      );
      for (const document of page.items) {
        resources.push({
          uri: `foundry://document/${encodeURIComponent(document.uuid)}`,
          name: document.name ?? document.uuid,
          description: `${type.type} in ${connection.worldTitle}`,
          mimeType: "application/json",
        });
        if (resources.length >= 500) break;
      }
    }
  }
  return resources;
}

async function enumerableSessions(bridge: BridgeConnection) {
  const listedConnections = await connections(bridge);
  const resources: Array<{ uri: string; name: string; description: string; mimeType: string }> = [];
  for (const connection of listedConnections.connections) {
    const page = await requestBridgeValue(
      bridge,
      "sessions.list",
      { connectionId: connection.connectionId, pageSize: 100 },
      SessionsListOutput,
    );
    for (const session of page.sessions) {
      resources.push({
        uri: `foundry://session/${encodeURIComponent(session.sessionId)}`,
        name: session.title,
        description: `${session.status} session in ${connection.worldTitle}`,
        mimeType: "application/json",
      });
    }
  }
  return resources;
}

export function registerFoundryResources(
  server: McpServer,
  bridge: BridgeConnection,
  intelligence: IntelligenceBridgeApi,
): void {
  server.registerResource(
    "foundry-connections",
    "foundry://connections",
    { ...JSON_RESOURCE, title: "Foundry connections" },
    async (uri) => textResource(uri, await connections(bridge)),
  );

  server.registerResource(
    "foundry-world",
    new ResourceTemplate("foundry://world/{connectionId}", {
      list: async () => {
        const value = await connections(bridge);
        return {
          resources: value.connections.map((connection) => ({
            uri: `foundry://world/${encodeURIComponent(connection.connectionId)}`,
            name: connection.worldTitle,
            description: `Foundry world ${connection.worldId}`,
            mimeType: "application/json",
          })),
        };
      },
    }),
    { ...JSON_RESOURCE, title: "Foundry world" },
    async (uri, variables) => {
      const connectionId = variable(variables.connectionId);
      const value = await connections(bridge);
      const connection = value.connections.find((entry) => entry.connectionId === connectionId);
      if (!connection) throw new Error(`Foundry connection not found: ${connectionId}`);
      const types = await requestBridgeValue(
        bridge,
        "documents.types",
        { connectionId },
        DocumentsTypesOutput,
      );
      return textResource(uri, { connection, documentTypes: types.types });
    },
  );

  server.registerResource(
    "foundry-document",
    new ResourceTemplate("foundry://document/{uuid}", {
      list: async () => ({ resources: await enumerableDocuments(bridge) }),
    }),
    { ...JSON_RESOURCE, title: "Foundry Document" },
    async (uri, variables) =>
      textResource(
        uri,
        await requestBridgeValue(
          bridge,
          "documents.get",
          { uuid: variable(variables.uuid) },
          DocumentsGetOutput,
        ),
      ),
  );

  server.registerResource(
    "foundry-session",
    new ResourceTemplate("foundry://session/{uuid}", {
      list: async () => ({ resources: await enumerableSessions(bridge) }),
    }),
    { ...JSON_RESOURCE, title: "Foundry journal session" },
    async (uri, variables) =>
      textResource(
        uri,
        await requestBridgeValue(
          bridge,
          "sessions.get",
          { sessionId: variable(variables.uuid), pageSize: 100 },
          SessionsGetOutput,
        ),
      ),
  );

  server.registerResource(
    "foundry-intelligence-latest",
    "foundry://intelligence/latest",
    { ...JSON_RESOURCE, title: "Latest Foundry intelligence" },
    async (uri) => {
      const value = await connections(bridge);
      const worlds = [];
      for (const connection of value.connections) {
        worlds.push({
          connectionId: connection.connectionId,
          timeline: await intelligence.timeline({ connectionId: connection.connectionId, limit: 25 }),
        });
      }
      return textResource(uri, { worlds });
    },
  );
}
