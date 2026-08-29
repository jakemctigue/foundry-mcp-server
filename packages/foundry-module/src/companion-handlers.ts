import { makeError, type JsonValue, type OperationResult } from "@foundry-mcp/protocol";

import type { FoundryAssetService } from "./assets.js";
import type { FoundryDocumentService } from "./documents.js";
import type { FoundrySessionService } from "./sessions.js";

export interface CompanionServices {
  documents: FoundryDocumentService;
  assets: FoundryAssetService;
  sessions: FoundrySessionService;
}
type CompanionHandler = (params: unknown) => Promise<OperationResult<unknown>>;

/**
 * Browser-only request dispatcher. All side effects flow through the runtime
 * services, which use public Document, embedded Document, and FilePicker APIs.
 */
export class FoundryCompanionHandlers {
  readonly #handlers: ReadonlyMap<string, CompanionHandler>;

  constructor(readonly services: CompanionServices) {
    this.#handlers = new Map<string, CompanionHandler>([
      ["documents.types", (params) => services.documents.types(params)],
      ["documents.list", (params) => services.documents.list(params)],
      ["documents.get", (params) => services.documents.get(params)],
      ["documents.create", (params) => services.documents.create(params)],
      ["documents.update", (params) => services.documents.update(params)],
      ["documents.embedded.list", (params) => services.documents.embeddedList(params)],
      ["compendiums.list", (params) => services.documents.compendiumsList(params)],
      [
        "compendiums.documents.list",
        (params) => services.documents.compendiumDocumentsList(params),
      ],
      ["documents.snapshot", (params) => services.documents.snapshot(params)],
      ["assets.images.list", (params) => services.assets.list(params)],
      ["assets.references.find", (params) => services.assets.referencesFind(params)],
      ["assets.images.upload", (params) => services.assets.upload(params)],
      ["assets.images.attach", (params) => services.assets.attach(params)],
      ["sessions.start", (params) => services.sessions.start(params)],
      ["sessions.append", (params) => services.sessions.append(params)],
      ["sessions.list", (params) => services.sessions.list(params)],
      ["sessions.get", (params) => services.sessions.get(params)],
      ["sessions.end", (params) => services.sessions.end(params)],
      ["sessions.reopen", (params) => services.sessions.reopen(params)],
    ]);
  }

  methods(): string[] {
    return [...this.#handlers.keys()].sort();
  }

  async handle(method: string, params: unknown): Promise<OperationResult<JsonValue>> {
    const handler = this.#handlers.get(method);
    if (!handler) {
      return { ok: false, error: makeError("NOT_FOUND", `Unknown companion method ${method}`) };
    }
    try {
      const result = await handler(params);
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
