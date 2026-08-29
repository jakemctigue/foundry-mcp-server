import {
  IntelligenceChangedSinceInput,
  IntelligenceContextInput,
  IntelligenceSearchInput,
  IntelligenceTimelineInput,
  makeError,
} from "@foundry-mcp/protocol";

import { IntelligenceBridgeApi } from "../intelligence-api.js";
import { BridgeResultError, type ToolServer } from "./bridge-tool.js";

function toolResult<T extends Record<string, unknown>>(operation: () => Promise<T>) {
  return async (): Promise<
    | { content: Array<{ type: "text"; text: string }>; structuredContent: T }
    | { content: Array<{ type: "text"; text: string }>; isError: true }
  > => {
    try {
      const value = await operation();
      return {
        content: [{ type: "text", text: "Foundry intelligence query completed successfully." }],
        structuredContent: value,
      };
    } catch (error) {
      const envelope =
        error instanceof BridgeResultError
          ? error.envelope
          : makeError("OFFLINE_BRIDGE", "Foundry intelligence bridge request failed", true);
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        isError: true,
      };
    }
  };
}
export function registerIntelligenceTools(server: ToolServer, api: IntelligenceBridgeApi): void {
  server.registerTool(
    "foundry.intelligence.search",
    {
      title: "Search Foundry intelligence",
      description: "Searches the local redacted event ledger with deterministic relevance ranking.",
      inputSchema: IntelligenceSearchInput,
    },
    (args) => toolResult(() => api.search(args))(),
  );
  server.registerTool(
    "foundry.intelligence.timeline",
    {
      title: "Read Foundry event timeline",
      description: "Reads a chronological, filtered, cursor-paginated local event timeline.",
      inputSchema: IntelligenceTimelineInput,
    },
    (args) => toolResult(() => api.timeline(args))(),
  );
  server.registerTool(
    "foundry.intelligence.changed-since",
    {
      title: "Read changed Foundry context",
      description: "Returns redacted events after exactly one sequence or timestamp cursor.",
      inputSchema: IntelligenceChangedSinceInput,
    },
    (args) => toolResult(() => api.changedSince(args))(),
  );
  server.registerTool(
    "foundry.intelligence.context",
    {
      title: "Build Foundry AI context",
      description: "Builds a bounded, redacted context pack with source-event provenance.",
      inputSchema: IntelligenceContextInput,
    },
    (args) => toolResult(() => api.context(args))(),
  );
}
