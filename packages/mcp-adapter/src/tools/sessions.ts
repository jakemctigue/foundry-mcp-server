import {
  SessionsAppendInput,
  SessionsAppendOutput,
  SessionsGetInput,
  SessionsGetOutput,
  SessionsListInput,
  SessionsListOutput,
  SessionsStartInput,
  SessionsStartOutput,
  SessionsStatusInput,
  SessionsStatusOutput,
} from "@foundry-mcp/protocol";

import type { BridgeConnection } from "../bridge-connection.js";
import type { MutationAuthorizer } from "../mutation-authorization.js";
import { mutationContext } from "../mutation-authorization.js";
import {
  forwardAuthorizedBridgeTool,
  forwardBridgeTool,
  type ToolServer,
} from "./bridge-tool.js";

export function registerSessionTools(
  server: ToolServer,
  bridge: BridgeConnection,
  authorizer?: MutationAuthorizer,
): void {
  server.registerTool(
    "foundry.sessions.start",
    {
      title: "Start a Foundry journal session",
      description:
        "Creates or reuses the configured Journal folder, then creates one JournalEntry and initial JournalEntryPage idempotently.",
      inputSchema: SessionsStartInput,
    },
    (args) =>
      forwardAuthorizedBridgeTool(
        authorizer,
        mutationContext("foundry.sessions.start", args, "sessions:start"),
        bridge,
        "sessions.start",
        args,
        SessionsStartOutput,
      ),
  );
  server.registerTool(
    "foundry.sessions.append",
    {
      title: "Append to a Foundry journal session",
      description:
        "Appends a sanitized, timestamped JournalEntryPage without replacing existing journal content. Idempotency keys prevent duplicate pages.",
      inputSchema: SessionsAppendInput,
    },
    (args) =>
      forwardAuthorizedBridgeTool(
        authorizer,
        mutationContext("foundry.sessions.append", args, "sessions:append"),
        bridge,
        "sessions.append",
        args,
        SessionsAppendOutput,
      ),
  );
  server.registerTool(
    "foundry.sessions.list",
    {
      title: "List Foundry journal sessions",
      description:
        "Lists module-owned journal session summaries with filters and cursor pagination.",
      inputSchema: SessionsListInput,
    },
    (args) => forwardBridgeTool(bridge, "sessions.list", args, SessionsListOutput),
  );
  server.registerTool(
    "foundry.sessions.get",
    {
      title: "Get a Foundry journal session",
      description: "Returns session metadata and its chronological JournalEntryPage timeline.",
      inputSchema: SessionsGetInput,
    },
    (args) => forwardBridgeTool(bridge, "sessions.get", args, SessionsGetOutput),
  );
  for (const operation of ["end", "reopen"] as const) {
    server.registerTool(
      `foundry.sessions.${operation}`,
      {
        title: `${operation === "end" ? "End" : "Reopen"} a Foundry journal session`,
        description:
          "Updates module-owned status metadata idempotently while retaining all prior JournalEntryPage content.",
        inputSchema: SessionsStatusInput,
      },
      (args) =>
        forwardAuthorizedBridgeTool(
          authorizer,
          mutationContext(`foundry.sessions.${operation}`, args, "sessions:append"),
          bridge,
          `sessions.${operation}`,
          args,
          SessionsStatusOutput,
        ),
    );
  }
}
