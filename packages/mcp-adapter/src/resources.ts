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
const MAX_ENUMERATED_RESOURCES = 500;

function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function textResource(uri: URL, value: unknown) {
  return {
    contents: [
      { uri: uri.href, mimeType: "application/json" as const, text: JSON.stringify(value) },
    ],
  };
}

function variable(value: string | string[] | undefined): string {
  if (value === undefined) throw new Error("required resource URI variable is missing");
  if (Array.isArray(value) && value.length !== 1) {
    throw new Error("resource URI variable must contain exactly one path segment");
  }
  const encoded = Array.isArray(value) ? (value[0] ?? "") : value;
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    throw new Error("resource URI variable is malformed");
  }
  if (decoded.length === 0 || decoded.length > 2_048) {
    throw new Error("resource URI variable has an invalid length");
  }
  return decoded;
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
      if (resources.length >= MAX_ENUMERATED_RESOURCES) break;
      const page = await requestBridgeValue(
        bridge,
        "documents.list",
        { connectionId: connection.connectionId, type: type.type, pageSize: 50 },
        DocumentsListOutput,
      );
      for (const document of page.items) {
        resources.push({
          uri: `foundry://document/${encodeSegment(connection.connectionId)}/${encodeSegment(document.uuid)}`,
          name: document.name ?? document.uuid,
          description: `${type.type} in ${connection.worldTitle}`,
          mimeType: "application/json",
        });
        if (resources.length >= MAX_ENUMERATED_RESOURCES) break;
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
      if (resources.length >= MAX_ENUMERATED_RESOURCES) break;
      resources.push({
        uri: `foundry://session/${encodeSegment(connection.connectionId)}/${encodeSegment(session.sessionId)}`,
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
            uri: `foundry://world/${encodeSegment(connection.connectionId)}`,
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
    new ResourceTemplate("foundry://document/{connectionId}/{uuid}", {
      list: async () => ({ resources: await enumerableDocuments(bridge) }),
    }),
    { ...JSON_RESOURCE, title: "Foundry Document" },
    async (uri, variables) => {
      const connectionId = variable(variables.connectionId);
      return textResource(
        uri,
        await requestBridgeValue(
          bridge,
          "documents.get",
          { connectionId, uuid: variable(variables.uuid) },
          DocumentsGetOutput,
        ),
      );
    },
  );

  server.registerResource(
    "foundry-session",
    new ResourceTemplate("foundry://session/{connectionId}/{sessionId}", {
      list: async () => ({ resources: await enumerableSessions(bridge) }),
    }),
    { ...JSON_RESOURCE, title: "Foundry journal session" },
    async (uri, variables) => {
      const connectionId = variable(variables.connectionId);
      return textResource(
        uri,
        await requestBridgeValue(
          bridge,
          "sessions.get",
          { connectionId, sessionId: variable(variables.sessionId), pageSize: 100 },
          SessionsGetOutput,
        ),
      );
    },
  );

  server.registerResource(
    "foundry-intelligence-latest",
    new ResourceTemplate("foundry://intelligence/{connectionId}/latest", {
      list: async () => {
        const value = await connections(bridge);
        return {
          resources: value.connections.map((connection) => ({
            uri: `foundry://intelligence/${encodeSegment(connection.connectionId)}/latest`,
            name: `Latest intelligence for ${connection.worldTitle}`,
            description: `Latest public-safe intelligence for Foundry world ${connection.worldId}`,
            mimeType: "application/json",
          })),
        };
      },
    }),
    { ...JSON_RESOURCE, title: "Latest Foundry intelligence" },
    async (uri, variables) => {
      const connectionId = variable(variables.connectionId);
      const value = await connections(bridge);
      const connection = value.connections.find((entry) => entry.connectionId === connectionId);
      if (!connection) throw new Error(`Foundry connection not found: ${connectionId}`);
      const timeline = await intelligence.timeline({ connectionId, limit: 25 });
      return textResource(uri, { connection, timeline });
    },
  );
}
