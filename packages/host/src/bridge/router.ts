import {
  AssetsImagesAttachInput,
  AssetsImagesGenerateInput,
  AssetsImagesUploadInput,
  BRIDGE_PROTOCOL_VERSION,
  ErrorEnvelope,
  IntelligenceChangedSinceInput,
  IntelligenceContextInput,
  IntelligenceSearchInput,
  IntelligenceStatusInput,
  IntelligenceTimelineInput,
  makeError,
  type JsonValue,
  type RequestedCapability,
} from "@foundry-mcp/protocol";
import type Database from "better-sqlite3";

import { importImageUrl, UrlImportError } from "../assets/url-import.js";
import {
  LocalImageError,
  type LocalImageErrorCode,
  type LocalImageLoader,
} from "../assets/local-file.js";
import { buildContextPack } from "../intelligence/context-pack.js";
import { getChangedSincePage, getTimeline, searchIntelligence } from "../intelligence/queries.js";
import { getIntelligenceStatus } from "../intelligence/reconciliation.js";
import {
  DeterministicImageProvider,
  ImageProviderError,
  ImageProviderRegistry,
} from "../providers/images.js";
import { PermissionDeniedError, runAuthorizedOperation } from "../security/policy.js";
import type { HostCompanionServer } from "./companion-server.js";

const MUTATION_CAPABILITIES = {
  "documents.create": "documents:create",
  "documents.update": "documents:update",
  "assets.images.upload": "assets:upload",
  "assets.images.generate": "assets:upload",
  "assets.images.attach": "assets:attach",
  "sessions.start": "sessions:start",
  "sessions.append": "sessions:append",
  "sessions.end": "sessions:append",
  "sessions.reopen": "sessions:append",
} as const satisfies Record<string, Exclude<RequestedCapability, "read">>;

const READ_METHODS = new Set([
  "documents.types",
  "documents.list",
  "documents.get",
  "documents.embedded.list",
  "documents.snapshot",
  "compendiums.list",
  "compendiums.documents.list",
  "assets.images.list",
  "assets.references.find",
  "sessions.list",
  "sessions.get",
]);

type UnknownRecord = Record<string, unknown>;
type UrlImporter = typeof importImageUrl;
type AuditFailureReporter = (error: Error, committed: boolean) => void;

const LOCAL_IMAGE_ERROR_MESSAGES: Record<LocalImageErrorCode, string> = {
  OUTSIDE_ROOT: "Local image path is outside the configured roots",
  REPARSE_POINT: "Local image paths cannot contain symbolic links or junctions",
  SIZE_LIMIT: "Local image exceeds the configured size limit",
  NOT_FILE: "Local image path is not a regular file",
  CHANGED_DURING_READ: "Local image changed while it was being authorized",
  MIME_MISMATCH: "Local image MIME type does not match its contents",
  INVALID_IMAGE: "Local image is not a supported valid image",
  READ_FAILED: "Local image could not be read safely",
};

class CompanionOperationError extends Error {
  constructor(readonly envelope: ReturnType<typeof makeError>) {
    super(envelope.message);
    this.name = "CompanionOperationError";
  }
}

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" ? (value as UnknownRecord) : {};
}

function jsonRecord(value: unknown): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(record(value))) as Record<string, JsonValue>;
}

function redactUploadSource(value: unknown): Record<string, JsonValue> {
  const source = jsonRecord(value);
  if (source["kind"] === "file" && typeof source["path"] === "string") {
    source["path"] = "[REDACTED]";
  }
  if (
    (source["kind"] === "base64" || source["kind"] === "generated") &&
    typeof source["data"] === "string"
  ) {
    source["data"] = "[REDACTED]";
  }
  return source;
}

function mutationAuditDetails(
  method: string,
  operationParams: UnknownRecord,
): Record<string, JsonValue> {
  const safe = jsonRecord(operationParams);
  if (method === "assets.images.upload") {
    safe["source"] = redactUploadSource(safe["source"]);
  }
  if (method === "assets.images.attach") {
    const asset = jsonRecord(safe["asset"]);
    if (asset["kind"] === "upload") asset["source"] = redactUploadSource(asset["source"]);
    safe["asset"] = asset;
  }
  return safe;
}

function localImageFailure(error: unknown): CompanionOperationError {
  const code = error instanceof LocalImageError ? error.code : "READ_FAILED";
  return new CompanionOperationError(
    makeError("INVALID_DATA", LOCAL_IMAGE_ERROR_MESSAGES[code], false, {
      localFileCode: code,
    }),
  );
}

async function resolveLocalImageSource(
  source: { path: string; mimeType?: string | undefined },
  loader?: LocalImageLoader,
): Promise<{ kind: "base64"; data: string; mimeType: string }> {
  if (!loader) {
    throw new CompanionOperationError(
      makeError("PERMISSION_DENIED", "Local image file access is disabled", false, {
        localFileCode: "DISABLED",
      }),
    );
  }
  try {
    const loaded = await loader(source.path);
    const declaredMimeType = source.mimeType?.toLowerCase().split(";")[0]?.trim();
    if (declaredMimeType && declaredMimeType !== loaded.mimeType) {
      throw new LocalImageError(
        "MIME_MISMATCH",
        "Local image MIME type does not match its contents",
      );
    }
    return {
      kind: "base64",
      data: Buffer.from(loaded.bytes).toString("base64"),
      mimeType: loaded.mimeType,
    };
  } catch (error) {
    if (error instanceof CompanionOperationError) throw error;
    throw localImageFailure(error);
  }
}

function defaultImageProviders(): ImageProviderRegistry {
  return new ImageProviderRegistry().register(new DeterministicImageProvider());
}

export class HostBridgeRouter {
  constructor(
    readonly db: Database.Database,
    readonly companion: HostCompanionServer,
    readonly imageProviders: ImageProviderRegistry = defaultImageProviders(),
    readonly urlImporter: UrlImporter = importImageUrl,
    readonly reportAuditFailure?: AuditFailureReporter,
    readonly localImageLoader?: LocalImageLoader,
  ) {}

  handle(message: unknown, respond: (response: unknown) => void): void {
    const request = record(message);
    const id = typeof request.id === "string" ? request.id : undefined;
    const method = typeof request.method === "string" ? request.method : "";
    const params = record(request.params);
    void this.dispatch(method, params)
      .then((result) => respond({ id, result }))
      .catch((error: unknown) => {
        if (error instanceof PermissionDeniedError) {
          respond({
            id,
            result: {
              ok: false,
              error: makeError("PERMISSION_DENIED", error.message, false, error.toJSON()),
            },
          });
          return;
        }
        if (error instanceof CompanionOperationError) {
          respond({ id, result: { ok: false, error: error.envelope } });
          return;
        }
        respond({
          id,
          result: {
            ok: false,
            error: makeError(
              "FOUNDRY_ERROR",
              error instanceof Error ? error.message : "Host bridge request failed",
            ),
          },
        });
      });
  }

  async dispatch(method: string, params: UnknownRecord): Promise<unknown> {
    if (method === "initialize") return { protocolVersion: BRIDGE_PROTOCOL_VERSION };
    if (method === "connections.list") {
      return {
        connections: this.companion.listConnections().map((entry) => ({
          connectionId: entry.connectionId,
          worldId: entry.worldId,
          worldTitle: entry.worldTitle,
          status: entry.status,
          ...(entry.foundryVersion ? { foundryVersion: entry.foundryVersion } : {}),
          currentUser: entry.currentUser,
          system: entry.system,
          activeModules: entry.activeModules,
          moduleCapabilities: entry.moduleCapabilities,
          lastSeenAt: entry.lastSeenAt,
        })),
      };
    }
    if (method === "intelligence.search") {
      const input = IntelligenceSearchInput.parse(params);
      return { results: searchIntelligence(this.db, input) };
    }
    if (method === "intelligence.status") {
      const input = IntelligenceStatusInput.parse(params);
      return getIntelligenceStatus(this.db, input.connectionId);
    }
    if (method === "intelligence.timeline") {
      const input = IntelligenceTimelineInput.parse(params);
      return getTimeline(this.db, {
        connectionId: input.connectionId,
        limit: input.limit,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.worldId === undefined ? {} : { worldId: input.worldId }),
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.to === undefined ? {} : { to: input.to }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
    }
    if (method === "intelligence.changed-since") {
      const input = IntelligenceChangedSinceInput.parse(params);
      return {
        ...getChangedSincePage(this.db, {
          connectionId: input.connectionId,
          limit: input.limit,
          ...(input.afterSequenceId === undefined
            ? { afterTimestamp: input.afterTimestamp as string }
            : { afterSequenceId: input.afterSequenceId }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        }),
      };
    }
    if (method === "intelligence.context") {
      const input = IntelligenceContextInput.parse(params);
      return buildContextPack(this.db, {
        connectionId: input.connectionId,
        maxEvents: input.maxEvents,
        maxObjects: input.maxObjects,
        maxBytes: input.maxBytes,
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.afterSequenceId === undefined ? {} : { afterSequenceId: input.afterSequenceId }),
        ...(input.afterTimestamp === undefined ? {} : { afterTimestamp: input.afterTimestamp }),
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.worldId === undefined ? {} : { worldId: input.worldId }),
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.to === undefined ? {} : { to: input.to }),
      });
    }
    if (method === "mutation.execute") return this.#mutation(params);
    if (method in MUTATION_CAPABILITIES) {
      return {
        ok: false,
        error: makeError(
          "PERMISSION_DENIED",
          `Mutation ${method} must use the policy interception endpoint`,
        ),
      };
    }
    if (!READ_METHODS.has(method)) {
      return { ok: false, error: makeError("NOT_FOUND", `Unknown bridge method ${method}`) };
    }
    const connectionId = this.#resolveConnectionId(params);
    return this.companion.request(connectionId, method, jsonRecord(params));
  }

  async #mutation(params: UnknownRecord): Promise<JsonValue> {
    const method = typeof params.method === "string" ? params.method : "";
    const operationParams = record(params.params);
    const authorization = record(params.authorization);
    const expectedCapability = MUTATION_CAPABILITIES[method as keyof typeof MUTATION_CAPABILITIES];
    if (!expectedCapability) throw new Error(`Unknown mutating method ${method}`);
    if (authorization.requestedCapability !== expectedCapability) {
      throw new Error(`Mutation capability mismatch for ${method}`);
    }
    const connectionId =
      typeof authorization.connectionId === "string"
        ? authorization.connectionId
        : this.#resolveConnectionId(operationParams);
    const connection = this.companion
      .listConnections()
      .find((entry) => entry.connectionId === connectionId);
    if (!connection) throw new Error(`Foundry connection is offline: ${connectionId}`);
    const tool = typeof authorization.tool === "string" ? authorization.tool : `foundry.${method}`;
    const correlationId =
      typeof authorization.correlationId === "string" ? authorization.correlationId : "missing";
    const assetKind = record(operationParams["asset"])["kind"];
    const additionalCapabilities: RequestedCapability[] =
      method === "assets.images.attach" && (assetKind === "upload" || assetKind === "url")
        ? ["assets:upload"]
        : [];
    return runAuthorizedOperation(
      this.db,
      {
        connectionId,
        foundryUserRole: connection.foundryUserRole,
        requestedCapability: expectedCapability,
        ...(additionalCapabilities.length > 0 ? { additionalCapabilities } : {}),
        tool,
        correlationId,
        auditDetails: mutationAuditDetails(method, operationParams),
        ...(this.reportAuditFailure ? { onAuditFailure: this.reportAuditFailure } : {}),
      },
      async () => {
        let companionMethod = method;
        let companionParams = jsonRecord(operationParams);
        let generation: { provider: string; model?: string } | undefined;
        if (
          method === "assets.images.upload" &&
          record(operationParams["source"])["kind"] === "file"
        ) {
          const input = AssetsImagesUploadInput.parse(operationParams);
          if (input.source.kind !== "file")
            throw new Error("Local image source changed unexpectedly");
          companionParams = jsonRecord({
            ...input,
            connectionId,
            source: await resolveLocalImageSource(input.source, this.localImageLoader),
          });
        }
        if (method === "assets.images.attach") {
          const input = AssetsImagesAttachInput.parse(operationParams);
          if (input.asset.kind === "upload" && input.asset.source.kind === "file") {
            companionParams = jsonRecord({
              ...input,
              connectionId,
              asset: {
                ...input.asset,
                source: await resolveLocalImageSource(input.asset.source, this.localImageLoader),
              },
            });
          } else if (input.asset.kind === "url") {
            try {
              const imported = await this.urlImporter(input.asset.url);
              companionParams = jsonRecord({
                ...input,
                connectionId,
                asset: {
                  kind: "upload",
                  sourceId: input.asset.sourceId,
                  destinationPath: input.asset.destinationPath,
                  onCollision: input.asset.onCollision,
                  source: {
                    kind: "base64",
                    data: Buffer.from(imported.bytes).toString("base64"),
                    mimeType: imported.mimeType,
                  },
                },
              });
            } catch (error) {
              if (error instanceof UrlImportError) {
                throw new CompanionOperationError(
                  makeError("FOUNDRY_ERROR", error.message, false, {
                    urlImportCode: error.code,
                    ...(error.details ?? {}),
                  }),
                );
              }
              throw error;
            }
          }
        }
        if (method === "assets.images.generate") {
          const input = AssetsImagesGenerateInput.parse(operationParams);
          try {
            const generated = await this.imageProviders.generate(
              input.prompt,
              input.options,
              input.provider,
            );
            generation = {
              provider: generated.provider,
              ...(generated.model === undefined ? {} : { model: generated.model }),
            };
            companionMethod = "assets.images.upload";
            companionParams = jsonRecord({
              connectionId,
              sourceId: input.sourceId,
              destinationPath: input.destinationPath,
              onCollision: input.onCollision,
              source: {
                kind: "generated",
                data: Buffer.from(generated.bytes).toString("base64"),
                mimeType: generated.mimeType,
                provider: generated.provider,
              },
            });
          } catch (error) {
            if (error instanceof ImageProviderError) {
              throw new CompanionOperationError(
                makeError("FOUNDRY_ERROR", error.message, error.retryable, {
                  providerCode: error.code,
                  ...(error.details ?? {}),
                }),
              );
            }
            throw error;
          }
        }
        const result = await this.companion.request(
          connectionId,
          companionMethod,
          companionParams,
          correlationId,
        );
        const operationResult = record(result);
        if (operationResult.ok === false) {
          const parsedError = ErrorEnvelope.safeParse(operationResult.error);
          throw new CompanionOperationError(
            parsedError.success
              ? parsedError.data
              : makeError("FOUNDRY_ERROR", "Companion returned a malformed operation error"),
          );
        }
        if (generation && operationResult.ok === true) {
          return {
            ...operationResult,
            value: { ...record(operationResult.value), ...generation },
          } as JsonValue;
        }
        return result;
      },
    );
  }

  #resolveConnectionId(params: UnknownRecord): string {
    if (typeof params.connectionId === "string" && params.connectionId.length > 0)
      return params.connectionId;
    const connections = this.companion.listConnections();
    if (connections.length === 1) return connections[0]?.connectionId as string;
    if (connections.length === 0) throw new Error("No Foundry connections are online");
    throw new Error("connectionId is required when multiple Foundry worlds are online");
  }
}
