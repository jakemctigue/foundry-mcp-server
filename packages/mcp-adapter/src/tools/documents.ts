import {
  CompendiumDocumentsListInput,
  CompendiumDocumentsListOutput,
  CompendiumsListInput,
  CompendiumsListOutput,
  DocumentsCreateInput,
  DocumentsCreateOutput,
  DocumentsGetInput,
  DocumentsGetOutput,
  DocumentsListInput,
  DocumentsListOutput,
  DocumentsSnapshotInput,
  DocumentsSnapshotOutput,
  DocumentsTypesInput,
  DocumentsTypesOutput,
  DocumentsUpdateInput,
  DocumentsUpdateOutput,
  EmbeddedDocumentsListInput,
  EmbeddedDocumentsListOutput,
} from "@foundry-mcp/protocol";

import type { BridgeConnection } from "../bridge-connection.js";
import type { MutationAuthorizer } from "../mutation-authorization.js";
import { mutationContext } from "../mutation-authorization.js";
import {
  forwardAuthorizedBridgeTool,
  forwardBridgeTool,
  bridgeRequestOptions,
  type ToolServer,
} from "./bridge-tool.js";

export function registerDocumentTools(
  server: ToolServer,
  bridge: BridgeConnection,
  authorizer?: MutationAuthorizer,
): void {
  server.registerTool(
    "foundry.documents.types",
    {
      title: "List Foundry Document types",
      description:
        "Enumerates runtime Document registrations, subtypes, and effective capabilities.",
      inputSchema: DocumentsTypesInput,
    },
    (args, context) =>
      forwardBridgeTool(
        bridge,
        "documents.types",
        args,
        DocumentsTypesOutput,
        bridgeRequestOptions(context),
      ),
  );
  server.registerTool(
    "foundry.documents.list",
    {
      title: "List Foundry Documents",
      description:
        "Lists any visible world Document type with stable sorting and cursor pagination.",
      inputSchema: DocumentsListInput,
    },
    (args, context) =>
      forwardBridgeTool(
        bridge,
        "documents.list",
        args,
        DocumentsListOutput,
        bridgeRequestOptions(context),
      ),
  );
  server.registerTool(
    "foundry.documents.get",
    {
      title: "Get a Foundry Document",
      description: "Resolves a world, embedded, or compendium UUID and returns a serialized view.",
      inputSchema: DocumentsGetInput,
    },
    (args, context) =>
      forwardBridgeTool(
        bridge,
        "documents.get",
        args,
        DocumentsGetOutput,
        bridgeRequestOptions(context),
      ),
  );
  server.registerTool(
    "foundry.documents.create",
    {
      title: "Create Foundry Documents",
      description:
        "Creates validated root or embedded Documents, with optional atomic batch rollback.",
      inputSchema: DocumentsCreateInput,
    },
    (args, context) => {
      const options = bridgeRequestOptions(context);
      return forwardAuthorizedBridgeTool(
        authorizer,
        mutationContext(
          "foundry.documents.create",
          args,
          "documents:create",
          options.correlationId,
        ),
        bridge,
        "documents.create",
        args,
        DocumentsCreateOutput,
        options,
      );
    },
  );
  server.registerTool(
    "foundry.documents.update",
    {
      title: "Update a Foundry Document",
      description:
        "Updates a UUID with optimistic concurrency while preserving unknown system fields.",
      inputSchema: DocumentsUpdateInput,
    },
    (args, context) => {
      const options = bridgeRequestOptions(context);
      return forwardAuthorizedBridgeTool(
        authorizer,
        mutationContext(
          "foundry.documents.update",
          args,
          "documents:update",
          options.correlationId,
        ),
        bridge,
        "documents.update",
        args,
        DocumentsUpdateOutput,
        options,
      );
    },
  );
  server.registerTool(
    "foundry.documents.embedded.list",
    {
      title: "List embedded Foundry Documents",
      description: "Recursively enumerates embedded Documents with depth and page bounds.",
      inputSchema: EmbeddedDocumentsListInput,
    },
    (args, context) =>
      forwardBridgeTool(
        bridge,
        "documents.embedded.list",
        args,
        EmbeddedDocumentsListOutput,
        bridgeRequestOptions(context),
      ),
  );
  server.registerTool(
    "foundry.compendiums.list",
    {
      title: "List Foundry compendiums",
      description: "Lists accessible compendium packs and lock state.",
      inputSchema: CompendiumsListInput,
    },
    (args, context) =>
      forwardBridgeTool(
        bridge,
        "compendiums.list",
        args,
        CompendiumsListOutput,
        bridgeRequestOptions(context),
      ),
  );
  server.registerTool(
    "foundry.compendiums.documents.list",
    {
      title: "List compendium Documents",
      description: "Lists or hydrates a compendium index with stable cursor pagination.",
      inputSchema: CompendiumDocumentsListInput,
    },
    (args, context) =>
      forwardBridgeTool(
        bridge,
        "compendiums.documents.list",
        args,
        CompendiumDocumentsListOutput,
        bridgeRequestOptions(context),
      ),
  );
  server.registerTool(
    "foundry.documents.snapshot",
    {
      title: "Snapshot Foundry Documents",
      description: "Builds a bounded, redacted JSON snapshot by UUID or query.",
      inputSchema: DocumentsSnapshotInput,
    },
    (args, context) =>
      forwardBridgeTool(
        bridge,
        "documents.snapshot",
        args,
        DocumentsSnapshotOutput,
        bridgeRequestOptions(context),
      ),
  );
}
