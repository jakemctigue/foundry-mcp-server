import {
  makeError,
  type JsonValue,
  type OperationExecutionOptions,
  type OperationResult,
} from "@foundry-mcp/protocol";

import type { FoundryAssetService } from "./assets.js";
import type { FoundryDocumentService } from "./documents.js";
import type { FoundrySessionService } from "./sessions.js";

export interface CompanionServices {
  documents: FoundryDocumentService;
  assets: FoundryAssetService;
  sessions: FoundrySessionService;
}
type CompanionHandler = (
  params: unknown,
  options?: OperationExecutionOptions,
) => Promise<OperationResult<unknown>>;

/**
 * Browser-only request dispatcher. All side effects flow through the runtime
 * services, which use public Document, embedded Document, and FilePicker APIs.
 */
export class FoundryCompanionHandlers {
  readonly #handlers: ReadonlyMap<string, CompanionHandler>;

  constructor(readonly services: CompanionServices) {
    this.#handlers = new Map<string, CompanionHandler>([
      ["documents.types", (params, options) => services.documents.types(params, options)],
      ["documents.list", (params, options) => services.documents.list(params, options)],
      ["documents.get", (params, options) => services.documents.get(params, options)],
      ["documents.create", (params, options) => services.documents.create(params, options)],
      ["documents.update", (params, options) => services.documents.update(params, options)],
      [
        "documents.embedded.list",
        (params, options) => services.documents.embeddedList(params, options),
      ],
      [
        "compendiums.list",
        (params, options) => services.documents.compendiumsList(params, options),
      ],
      [
        "compendiums.documents.list",
        (params, options) => services.documents.compendiumDocumentsList(params, options),
      ],
      ["documents.snapshot", (params, options) => services.documents.snapshot(params, options)],
      ["assets.images.list", (params, options) => services.assets.list(params, options)],
      [
        "assets.references.find",
        (params, options) => services.assets.referencesFind(params, options),
      ],
      ["assets.images.upload", (params, options) => services.assets.upload(params, options)],
      ["assets.images.attach", (params, options) => services.assets.attach(params, options)],
      ["sessions.start", (params, options) => services.sessions.start(params, options)],
      ["sessions.append", (params, options) => services.sessions.append(params, options)],
      ["sessions.list", (params, options) => services.sessions.list(params, options)],
      ["sessions.get", (params, options) => services.sessions.get(params, options)],
      ["sessions.end", (params, options) => services.sessions.end(params, options)],
      ["sessions.reopen", (params, options) => services.sessions.reopen(params, options)],
    ]);
  }

  methods(): string[] {
    return [...this.#handlers.keys()].sort();
  }

  async handle(
    method: string,
    params: unknown,
    options?: OperationExecutionOptions,
  ): Promise<OperationResult<JsonValue>> {
    const handler = this.#handlers.get(method);
    if (!handler) {
      return { ok: false, error: makeError("NOT_FOUND", `Unknown companion method ${method}`) };
    }
    try {
      const result = await handler(params, options);
      return JSON.parse(JSON.stringify(result)) as OperationResult<JsonValue>;
    } catch (error) {
      return {
        ok: false,
        error: makeError(
          "FOUNDRY_ERROR",
          error instanceof Error ? error.message : "Foundry companion operation failed",
        ),
      };
    }
  }
}
