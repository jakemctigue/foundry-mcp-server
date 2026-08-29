import {
  AssetsImagesAttachInput,
  AssetsImagesAttachOutput,
  AssetsImagesGenerateInput,
  AssetsImagesGenerateOutput,
  AssetsImagesListInput,
  AssetsImagesListOutput,
  AssetsImagesUploadInput,
  AssetsImagesUploadOutput,
  AssetsReferencesFindInput,
  AssetsReferencesFindOutput,
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

export function registerAssetTools(
  server: ToolServer,
  bridge: BridgeConnection,
  authorizer?: MutationAuthorizer,
): void {
  server.registerTool(
    "foundry.assets.images.list",
    {
      title: "List Foundry image assets",
      description:
        "Enumerates image assets exposed by Foundry FilePicker sources with source capabilities, bounded recursion, deduplication, filters, and cursor pagination.",
      inputSchema: AssetsImagesListInput,
    },
    (args, context) =>
      forwardBridgeTool(
        bridge,
        "assets.images.list",
        args,
        AssetsImagesListOutput,
        bridgeRequestOptions(context),
      ),
  );
  server.registerTool(
    "foundry.assets.references.find",
    {
      title: "Find Foundry image references",
      description:
        "Finds image-looking strings in selected Foundry Documents and returns their owning UUID and JSON Pointer path.",
      inputSchema: AssetsReferencesFindInput,
    },
    (args, context) =>
      forwardBridgeTool(
        bridge,
        "assets.references.find",
        args,
        AssetsReferencesFindOutput,
        bridgeRequestOptions(context),
      ),
  );
  server.registerTool(
    "foundry.assets.images.upload",
    {
      title: "Upload a Foundry image",
      description:
        "Validates and uploads an image through an authorized writable Foundry FilePicker source with an explicit collision policy.",
      inputSchema: AssetsImagesUploadInput,
    },
    (args, context) => {
      const options = bridgeRequestOptions(context);
      return forwardAuthorizedBridgeTool(
        authorizer,
        mutationContext(
          "foundry.assets.images.upload",
          args,
          "assets:upload",
          options.correlationId,
        ),
        bridge,
        "assets.images.upload",
        args,
        AssetsImagesUploadOutput,
        options,
      );
    },
  );
  server.registerTool(
    "foundry.assets.images.generate",
    {
      title: "Generate and store a Foundry image",
      description:
        "Generates a bounded image with the explicitly reported provider and stores it through Foundry FilePicker. The deterministic provider is the local default; external providers never receive silent fallback.",
      inputSchema: AssetsImagesGenerateInput,
    },
    (args, context) => {
      const options = bridgeRequestOptions(context);
      return forwardAuthorizedBridgeTool(
        authorizer,
        mutationContext(
          "foundry.assets.images.generate",
          args,
          "assets:upload",
          options.correlationId,
          args.provider === "deterministic" ? [] : ["ai:network"],
        ),
        bridge,
        "assets.images.generate",
        args,
        AssetsImagesGenerateOutput,
        options,
      );
    },
  );
  server.registerTool(
    "foundry.assets.images.attach",
    {
      title: "Attach an image to a Foundry Document",
      description:
        "Atomically uploads or references an image and updates an authorized Foundry Document field with one audit event.",
      inputSchema: AssetsImagesAttachInput,
    },
    (args, context) => {
      const options = bridgeRequestOptions(context);
      const additionalCapabilities =
        args.asset.kind === "url"
          ? (["assets:upload", "ai:network"] as const)
          : args.asset.kind === "upload"
            ? (["assets:upload"] as const)
            : [];
      return forwardAuthorizedBridgeTool(
        authorizer,
        mutationContext(
          "foundry.assets.images.attach",
          args,
          "assets:attach",
          options.correlationId,
          additionalCapabilities,
        ),
        bridge,
        "assets.images.attach",
        args,
        AssetsImagesAttachOutput,
        options,
      );
    },
  );
}
