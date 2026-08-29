import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  PROTOCOL_VERSION,
  ConnectionsListOutput,
  CapabilitiesGetOutput,
  makeError,
  type CapabilitiesGetOutput as CapabilitiesGetOutputData,
} from "@foundry-mcp/protocol";
import type { BridgeConnection } from "./bridge-connection.js";

// Accepts any object shape so the SDK never rejects the call before our
// handler runs; we perform the "no unexpected arguments" check ourselves so
// we can return the standard error envelope instead of a raw MCP protocol
// error.
const PermissiveNoArgs = z.looseObject({});

export interface CreateServerOptions {
  bridge: BridgeConnection;
}

function errorContent(
  code: Parameters<typeof makeError>[0],
  message: string,
): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const envelope = makeError(code, message, false);
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    isError: true,
  };
}

export function createFoundryMcpServer(options: CreateServerOptions): McpServer {
  const { bridge } = options;

  const server = new McpServer({
    name: "foundry-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "foundry.connections.list",
    {
      title: "List Foundry connections",
      description:
        "Lists currently paired Foundry VTT world connections known to the bridge daemon. Read-only, no side effects. Returns an empty array when no worlds are paired.",
      inputSchema: PermissiveNoArgs,
    },
    async (args: Record<string, unknown>) => {
      if (Object.keys(args).length > 0) {
        return errorContent("INVALID_DATA", "foundry.connections.list takes no arguments");
      }

      const result = (await bridge.request("connections.list")) as unknown;
      const parsed = ConnectionsListOutput.safeParse(result);
      if (!parsed.success) {
        return errorContent("INVALID_DATA", "bridge returned a malformed connections list");
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `${parsed.data.connections.length.toString()} connection(s) known to the bridge.`,
          },
        ],
        structuredContent: parsed.data,
      };
    },
  );

  server.registerTool(
    "foundry.capabilities.get",
    {
      title: "Get bridge capabilities",
      description:
        "Returns the negotiated MCP protocol version and the set of capabilities the bridge daemon currently exposes. Read-only, no side effects.",
      inputSchema: {},
    },
    () => {
      const data: CapabilitiesGetOutputData = {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: [
          { name: "documents", version: "0.1.0", readOnly: true },
          { name: "connections", version: "0.1.0", readOnly: true },
        ],
      };
      const parsed = CapabilitiesGetOutput.parse(data);
      return {
        content: [
          {
            type: "text" as const,
            text: `Protocol ${parsed.protocolVersion}; ${parsed.capabilities.length.toString()} capabilities available.`,
          },
        ],
        structuredContent: parsed,
      };
    },
  );

  return server;
}
