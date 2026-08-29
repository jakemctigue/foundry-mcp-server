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
      description: "Enumerates runtime Document registrations, subtypes, and effective capabilities.",
      inputSchema: DocumentsTypesInput,
    },
    (args) => forwardBridgeTool(bridge, "documents.types", args, DocumentsTypesOutput),
  );
  server.registerTool(
    "foundry.documents.list",
    {
      title: "List Foundry Documents",
      description: "Lists any visible world Document type with stable sorting and cursor pagination.",
      inputSchema: DocumentsListInput,
    },
    (args) => forwardBridgeTool(bridge, "documents.list", args, DocumentsListOutput),
  );
  server.registerTool(
    "foundry.documents.get",
    {
      title: "Get a Foundry Document",
      description: "Resolves a world, embedded, or compendium UUID and returns a serialized view.",
      inputSchema: DocumentsGetInput,
    },
    (args) => forwardBridgeTool(bridge, "documents.get", args, DocumentsGetOutput),
  );
  server.registerTool(
    "foundry.documents.create",
    {
      title: "Create Foundry Documents",
      description: "Creates validated root or embedded Documents, with optional atomic batch rollback.",
      inputSchema: DocumentsCreateInput,
    },
    (args) =>
      forwardAuthorizedBridgeTool(
        authorizer,
        mutationContext("foundry.documents.create", args, "documents:create"),
        bridge,
        "documents.create",
        args,
        DocumentsCreateOutput,
      ),
  );
  server.registerTool(
    "foundry.documents.update",
    {
      title: "Update a Foundry Document",
      description: "Updates a UUID with optimistic concurrency while preserving unknown system fields.",
      inputSchema: DocumentsUpdateInput,
    },
    (args) =>
      forwardAuthorizedBridgeTool(
        authorizer,
        mutationContext("foundry.documents.update", args, "documents:update"),
        bridge,
        "documents.update",
        args,
        DocumentsUpdateOutput,
      ),
  );
  server.registerTool(
    "foundry.documents.embedded.list",
    {
      title: "List embedded Foundry Documents",
      description: "Recursively enumerates embedded Documents with depth and page bounds.",
      inputSchema: EmbeddedDocumentsListInput,
    },
    (args) =>
      forwardBridgeTool(bridge, "documents.embedded.list", args, EmbeddedDocumentsListOutput),
  );
  server.registerTool(
    "foundry.compendiums.list",
    {
      title: "List Foundry compendiums",
      description: "Lists accessible compendium packs and lock state.",
      inputSchema: CompendiumsListInput,
    },
    (args) => forwardBridgeTool(bridge, "compendiums.list", args, CompendiumsListOutput),
  );
  server.registerTool(
    "foundry.compendiums.documents.list",
    {
      title: "List compendium Documents",
      description: "Lists or hydrates a compendium index with stable cursor pagination.",
      inputSchema: CompendiumDocumentsListInput,
    },
    (args) =>
      forwardBridgeTool(
        bridge,
        "compendiums.documents.list",
        args,
        CompendiumDocumentsListOutput,
      ),
  );
  server.registerTool(
    "foundry.documents.snapshot",
    {
      title: "Snapshot Foundry Documents",
      description: "Builds a bounded, redacted JSON snapshot by UUID or query.",
      inputSchema: DocumentsSnapshotInput,
    },
    (args) => forwardBridgeTool(bridge, "documents.snapshot", args, DocumentsSnapshotOutput),
  );
}
