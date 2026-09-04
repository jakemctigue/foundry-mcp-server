import type { JsonObject } from "@foundry-mcp/protocol";

export interface RuntimeSubtypeRegistration {
  subtype: string;
  label?: string;
  readable: boolean;
  creatable: boolean;
  updatable: boolean;
  reason?: string;
}

export interface RuntimeDocumentRegistration {
  type: string;
  collection?: string;
  embedded: boolean;
  parentTypes: string[];
  schemaVersion?: string;
  readable: boolean;
  creatable: boolean;
  updatable: boolean;
  reason?: string;
  subtypes: RuntimeSubtypeRegistration[];
}

export interface RuntimeDocument {
  id: string;
  uuid: string;
  documentName: string;
  subtype?: string;
  parent?: RuntimeDocument;
  pack?: string;
  ownership?: unknown;
  revision?: number | string;
  schemaVersion?: string;
  toObject(): unknown;
  raw: unknown;
}

export interface RuntimeCompendiumIndexEntry {
  id: string;
  uuid: string;
  name?: string;
  type: string;
  subtype?: string;
  img?: string;
}

export interface RuntimeCompendium {
  id: string;
  label: string;
  type: string;
  locked: boolean;
  accessible: boolean;
  writable: boolean;
  writeReason: string | undefined;
  documentCount: number;
  getIndex(): Promise<RuntimeCompendiumIndexEntry[]>;
  getDocuments(): Promise<RuntimeDocument[]>;
  createDocument(data: JsonObject): Promise<RuntimeDocument>;
}

export interface RuntimeDocumentValidation {
  schemaValidated: boolean;
  warnings: string[];
}

export interface RuntimeAuditEvent {
  action: string;
  uuid?: string;
  forced?: boolean;
  details?: JsonObject;
}

export interface FoundryRuntimeAdapter {
  isOnline(): boolean;
  listDocumentRegistrations(): Promise<RuntimeDocumentRegistration[]>;
  listRootDocuments(type: string): Promise<RuntimeDocument[]>;
  parseUuid(uuid: string): unknown | Promise<unknown>;
  fromUuid(uuid: string): Promise<RuntimeDocument | null>;
  listEmbeddedDocuments(parent: RuntimeDocument, embeddedType?: string): Promise<RuntimeDocument[]>;
  createDocument(
    type: string,
    data: JsonObject,
    parent?: RuntimeDocument,
  ): Promise<RuntimeDocument>;
  validateDocumentCreate?(
    type: string,
    data: JsonObject,
    parent?: RuntimeDocument,
    pack?: RuntimeCompendium,
  ): Promise<RuntimeDocumentValidation>;
  validateDocumentUpdate?(
    document: RuntimeDocument,
    data: JsonObject,
  ): Promise<RuntimeDocumentValidation>;
  updateDocument(document: RuntimeDocument, data: JsonObject): Promise<RuntimeDocument>;
  deleteDocument(document: RuntimeDocument): Promise<void>;
  canRead(document: RuntimeDocument): boolean;
  canCreate(
    type: string,
    subtype?: string,
    parent?: RuntimeDocument,
  ): { allowed: boolean; reason?: string };
  canUpdate(document: RuntimeDocument): { allowed: boolean; reason?: string };
  listCompendiums(): Promise<RuntimeCompendium[]>;
  getCompendium(packId: string): Promise<RuntimeCompendium | null>;
  audit(event: RuntimeAuditEvent): void | Promise<void>;
  snapshotState?(): unknown | Promise<unknown>;
  restoreState?(snapshot: unknown): void | Promise<void>;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? (value as UnknownRecord)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function values(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value instanceof Map || value instanceof Set) return [...value.values()];
  const candidate = record(value);
  if (Array.isArray(candidate.contents)) return candidate.contents;
  const iterator = candidate.values;
  if (typeof iterator === "function") {
    try {
      return [...(iterator.call(value) as Iterable<unknown>)];
    } catch {
      return [];
    }
  }
  return Object.values(candidate);
}

function call(target: unknown, key: string, ...args: unknown[]): unknown {
  const fn = record(target)[key];
  if (typeof fn !== "function") throw new Error(`Foundry runtime is missing ${key}()`);
  return fn.apply(target, args);
}

function documentId(raw: unknown): string {
  const item = record(raw);
  const id = stringValue(item.id) ?? stringValue(item._id);
  if (!id) throw new Error("Foundry returned a Document without an id");
  return id;
}

function documentType(raw: unknown): string {
  const item = record(raw);
  const ctor = record(item.constructor);
  return (
    stringValue(item.documentName) ??
    stringValue(ctor.documentName) ??
    stringValue(record(ctor.metadata).name) ??
    "Document"
  );
}

function wrapDocument(raw: unknown): RuntimeDocument {
  const item = record(raw);
  const id = documentId(raw);
  const parentRaw = item.parent;
  const pack = stringValue(item.pack);
  const type = documentType(raw);
  const uuid =
    stringValue(item.uuid) ?? (pack ? `Compendium.${pack}.${type}.${id}` : `${type}.${id}`);
  const subtype = stringValue(item.type);
  const stats = record(item._stats);
  const revision =
    (typeof stats.modifiedTime === "number" || typeof stats.modifiedTime === "string"
      ? stats.modifiedTime
      : undefined) ?? stringValue(stats.lastModifiedBy);
  const ctor = record(item.constructor);
  const metadata = record(ctor.metadata);
  const game = record((globalThis as unknown as UnknownRecord).game);
  const system = record(game.system);
  const release = record(game.release);
  const schemaVersion =
    stringValue(metadata.schemaVersion) ??
    stringValue(system.version) ??
    stringValue(release.version) ??
    "unknown";
  return {
    id,
    uuid,
    documentName: type,
    ...(subtype ? { subtype } : {}),
    ...(parentRaw ? { parent: wrapDocument(parentRaw) } : {}),
    ...(pack ? { pack } : {}),
    ...(item.ownership !== undefined ? { ownership: item.ownership } : {}),
    ...(revision !== undefined ? { revision } : {}),
    schemaVersion,
    // Export canonical source, not prepared system values or calculated fields.
    toObject: () => call(raw, "toObject", true),
    raw,
  };
}

function subtypeNames(value: unknown): Array<{ subtype: string; label?: string }> {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (typeof entry === "string" && entry.length > 0) return [{ subtype: entry }];
      const item = record(entry);
      const subtype = stringValue(item.type) ?? stringValue(item.name) ?? stringValue(item.id);
      const label = stringValue(item.label);
      return subtype ? [{ subtype, ...(label ? { label } : {}) }] : [];
    });
  }
  return Object.entries(record(value)).map(([subtype, label]) => ({
    subtype,
    ...(typeof label === "string" && label.length > 0 ? { label } : {}),
  }));
}

/**
 * Thin structural adapter over Foundry's documented globals. It deliberately
 * never serializes or returns a live Foundry object outside this package.
 */
export class BrowserFoundryRuntime implements FoundryRuntimeAdapter {
  readonly #globals: UnknownRecord;

  constructor(globals: UnknownRecord = globalThis as unknown as UnknownRecord) {
    this.#globals = globals;
  }

  isOnline(): boolean {
    const game = record(this.#globals.game);
    return game.user !== undefined && game.ready !== false;
  }

  async listDocumentRegistrations(): Promise<RuntimeDocumentRegistration[]> {
    const game = record(this.#globals.game);
    const config = record(this.#globals.CONFIG);
    const systemTypes = record(game.documentTypes);
    const discovered = new Map<string, { config: UnknownRecord; collection?: unknown }>();

    for (const [key, value] of Object.entries(config)) {
      const entry = record(value);
      if (entry.documentClass !== undefined) discovered.set(key, { config: entry });
    }
    for (const collection of values(game.collections)) {
      const item = record(collection);
      const type =
        stringValue(item.documentName) ??
        stringValue(record(item.documentClass).documentName) ??
        stringValue(record(record(item.documentClass).metadata).name);
      if (!type) continue;
      const prior = discovered.get(type) ?? { config: record(config[type]) };
      discovered.set(type, { ...prior, collection });
    }
    for (const type of Object.keys(systemTypes)) {
      if (!discovered.has(type)) discovered.set(type, { config: record(config[type]) });
    }

    const parentTypes = new Map<string, Set<string>>();
    for (const [parentType, entry] of discovered) {
      const metadata = record(record(entry.config.documentClass).metadata);
      for (const [embeddedName, embeddedTypeValue] of Object.entries(record(metadata.embedded))) {
        const embeddedType = stringValue(embeddedTypeValue) ?? embeddedName;
        const parents = parentTypes.get(embeddedType) ?? new Set<string>();
        parents.add(parentType);
        parentTypes.set(embeddedType, parents);
      }
    }

    const user = game.user;
    const isGm = record(user).isGM === true;
    const registrations: RuntimeDocumentRegistration[] = [];
    for (const [type, entry] of discovered) {
      const documentClass = entry.config.documentClass;
      const metadata = record(record(documentClass).metadata);
      const embeddedParents = [...(parentTypes.get(type) ?? [])].sort();
      let classCreatable = isGm;
      const canUserCreate = record(documentClass).canUserCreate;
      if (typeof canUserCreate === "function") {
        try {
          classCreatable = canUserCreate.call(documentClass, user) === true;
        } catch {
          classCreatable = false;
        }
      }
      const readable = entry.collection !== undefined || embeddedParents.length > 0;
      const reason = !readable
        ? "No visible world collection or embedded parent is available"
        : !classCreatable
          ? "The connected Foundry user cannot create this Document type"
          : undefined;
      const subtypes = subtypeNames(systemTypes[type]).map(({ subtype, label }) => ({
        subtype,
        ...(label ? { label } : {}),
        readable,
        creatable: classCreatable,
        updatable: isGm,
        ...(!readable || !classCreatable
          ? { reason: reason ?? "The connected Foundry user cannot mutate this subtype" }
          : {}),
      }));
      const collection = stringValue(metadata.collection);
      const schemaVersion = stringValue(metadata.schemaVersion);
      registrations.push({
        type,
        ...(collection ? { collection } : {}),
        embedded: embeddedParents.length > 0,
        parentTypes: embeddedParents,
        ...(schemaVersion ? { schemaVersion } : {}),
        readable,
        creatable: classCreatable,
        updatable: isGm,
        ...(reason ? { reason } : {}),
        subtypes,
      });
    }
    return registrations.sort((left, right) => left.type.localeCompare(right.type));
  }

  async listRootDocuments(type: string): Promise<RuntimeDocument[]> {
    const game = record(this.#globals.game);
    for (const collection of values(game.collections)) {
      const item = record(collection);
      const collectionType =
        stringValue(item.documentName) ??
        stringValue(record(item.documentClass).documentName) ??
        stringValue(record(record(item.documentClass).metadata).name);
      if (collectionType === type) return values(collection).map(wrapDocument);
    }
    const config = record(record(this.#globals.CONFIG)[type]);
    const collectionName = stringValue(record(record(config.documentClass).metadata).collection);
    if (collectionName && game[collectionName] !== undefined)
      return values(game[collectionName]).map(wrapDocument);
    return [];
  }

  parseUuid(uuid: string): unknown {
    const utils = record(record(this.#globals.foundry).utils);
    return call(utils, "parseUuid", uuid);
  }

  async fromUuid(uuid: string): Promise<RuntimeDocument | null> {
    const resolver = this.#globals.fromUuid;
    if (typeof resolver !== "function") throw new Error("Foundry runtime is missing fromUuid()");
    const resolved = await resolver(uuid);
    return resolved ? wrapDocument(resolved) : null;
  }

  async listEmbeddedDocuments(
    parent: RuntimeDocument,
    embeddedType?: string,
  ): Promise<RuntimeDocument[]> {
    const raw = parent.raw;
    const metadata = record(record(record(raw).constructor).metadata);
    const registeredTypes = Object.entries(record(metadata.embedded)).map(
      ([name, value]) => stringValue(value) ?? name,
    );
    const types = embeddedType ? [embeddedType] : registeredTypes;
    const documents: RuntimeDocument[] = [];
    for (const type of types) {
      try {
        documents.push(...values(call(raw, "getEmbeddedCollection", type)).map(wrapDocument));
      } catch {
        // A registered embedded collection may be absent from this particular instance.
      }
    }
    return documents;
  }

  async createDocument(
    type: string,
    data: JsonObject,
    parent?: RuntimeDocument,
  ): Promise<RuntimeDocument> {
    if (parent) {
      const created = (await call(parent.raw, "createEmbeddedDocuments", type, [data])) as unknown;
      const first = values(created)[0];
      if (!first) throw new Error(`Foundry did not return the created embedded ${type}`);
      return wrapDocument(first);
    }
    const documentClass = record(record(record(this.#globals.CONFIG)[type]).documentClass);
    const created = await call(documentClass, "create", data, { renderSheet: false });
    if (!created) throw new Error(`Foundry did not return the created ${type}`);
    return wrapDocument(created);
  }

  async validateDocumentCreate(
    type: string,
    data: JsonObject,
    parent?: RuntimeDocument,
    pack?: RuntimeCompendium,
  ): Promise<RuntimeDocumentValidation> {
    const documentClass = record(record(this.#globals.CONFIG)[type]).documentClass;
    if (typeof documentClass !== "function") {
      return {
        schemaValidated: false,
        warnings: ["Foundry did not expose a side-effect-free constructor for schema validation"],
      };
    }
    let candidate: unknown;
    try {
      candidate = Reflect.construct(documentClass, [
        data,
        {
          ...(parent ? { parent: parent.raw } : {}),
          ...(pack ? { pack: pack.id } : {}),
          strict: true,
        },
      ]);
    } catch (error) {
      throw new Error(
        `Foundry schema rejected ${type}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return this.#validateCandidate(candidate, type);
  }

  async validateDocumentUpdate(
    document: RuntimeDocument,
    data: JsonObject,
  ): Promise<RuntimeDocumentValidation> {
    const clone = record(document.raw).clone;
    if (typeof clone !== "function") {
      return {
        schemaValidated: false,
        warnings: ["Foundry did not expose a side-effect-free clone validator for this Document"],
      };
    }
    let candidate: unknown;
    try {
      candidate = await clone.call(document.raw, data, { save: false, keepId: true });
    } catch (error) {
      throw new Error(
        `Foundry schema rejected ${document.documentName} update: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    return this.#validateCandidate(candidate, document.documentName);
  }

  async updateDocument(document: RuntimeDocument, data: JsonObject): Promise<RuntimeDocument> {
    const updated = await call(document.raw, "update", data, { render: false });
    return wrapDocument(updated ?? document.raw);
  }

  async deleteDocument(document: RuntimeDocument): Promise<void> {
    await call(document.raw, "delete", { render: false });
  }

  canRead(document: RuntimeDocument): boolean {
    const test = record(document.raw).testUserPermission;
    if (typeof test !== "function") return true;
    try {
      return (
        test.call(document.raw, record(this.#globals.game).user, "LIMITED", { exact: false }) ===
        true
      );
    } catch {
      return false;
    }
  }

  canCreate(
    type: string,
    subtype?: string,
    parent?: RuntimeDocument,
  ): { allowed: boolean; reason?: string } {
    const game = record(this.#globals.game);
    if (record(game.user).isGM !== true)
      return { allowed: false, reason: "Generic mutations require a connected GM" };
    if (parent) {
      const canModify = record(parent.raw).canUserModify;
      if (
        typeof canModify === "function" &&
        canModify.call(parent.raw, game.user, "update") !== true
      ) {
        return { allowed: false, reason: "The connected user cannot update the parent Document" };
      }
    }
    const types = subtypeNames(record(game.documentTypes)[type]).map((entry) => entry.subtype);
    if (subtype && types.length > 0 && !types.includes(subtype)) {
      return { allowed: false, reason: `Subtype ${subtype} is not registered for ${type}` };
    }
    return { allowed: true };
  }

  canUpdate(document: RuntimeDocument): { allowed: boolean; reason?: string } {
    const game = record(this.#globals.game);
    if (record(game.user).isGM !== true)
      return { allowed: false, reason: "Generic mutations require a connected GM" };
    const canModify = record(document.raw).canUserModify;
    if (
      typeof canModify === "function" &&
      canModify.call(document.raw, game.user, "update") !== true
    ) {
      return { allowed: false, reason: "The connected user cannot update this Document" };
    }
    return { allowed: true };
  }

  async listCompendiums(): Promise<RuntimeCompendium[]> {
    return values(record(this.#globals.game).packs).map((pack) => this.#wrapPack(pack));
  }

  async getCompendium(packId: string): Promise<RuntimeCompendium | null> {
    const packs = record(this.#globals.game).packs;
    const getter = record(packs).get;
    const raw =
      typeof getter === "function"
        ? getter.call(packs, packId)
        : values(packs).find((pack) => stringValue(record(pack).collection) === packId);
    return raw ? this.#wrapPack(raw) : null;
  }

  async audit(event: RuntimeAuditEvent): Promise<void> {
    const hooks = this.#globals.Hooks;
    const callAll = record(hooks).callAll;
    if (typeof callAll === "function") callAll.call(hooks, "foundryMcpAudit", event);
  }

  #wrapPack(raw: unknown): RuntimeCompendium {
    const item = record(raw);
    const metadata = record(item.metadata);
    const id = stringValue(item.collection) ?? stringValue(metadata.id) ?? "unknown-pack";
    const label = stringValue(metadata.label) ?? stringValue(item.title) ?? id;
    const type = stringValue(item.documentName) ?? stringValue(metadata.type) ?? "Document";
    const locked = booleanValue(item.locked, booleanValue(metadata.locked, false));
    const accessible = booleanValue(item.visible, true);
    const game = record(this.#globals.game);
    const user = game.user;
    const documentClass =
      item.documentClass ?? record(record(this.#globals.CONFIG)[type]).documentClass;
    let writable = accessible && !locked && record(user).isGM === true;
    let writeReason = !accessible
      ? "The compendium is not accessible"
      : locked
        ? "The compendium is locked"
        : record(user).isGM !== true
          ? "Generic compendium mutations require a connected GM"
          : undefined;
    const canUserCreate = record(documentClass).canUserCreate;
    if (writable && typeof canUserCreate === "function") {
      try {
        writable = canUserCreate.call(documentClass, user) === true;
      } catch {
        writable = false;
      }
      if (!writable) writeReason = "The connected user cannot create Documents in this compendium";
    }
    const canUserModify = item.canUserModify;
    if (writable && typeof canUserModify === "function") {
      try {
        writable = canUserModify.call(raw, user, "update") === true;
      } catch {
        writable = false;
      }
      if (!writable) writeReason = "The connected user cannot modify this compendium";
    }
    const count = typeof item.size === "number" ? item.size : values(item.index).length;
    return {
      id,
      label,
      type,
      locked,
      accessible,
      writable,
      writeReason,
      documentCount: count,
      getIndex: async () => {
        const index = await call(raw, "getIndex");
        return Promise.all(
          values(index).map(async (entry) => {
            const data = record(entry);
            const entryId = stringValue(data._id) ?? stringValue(data.id) ?? "unknown";
            const name = stringValue(data.name);
            const subtype = stringValue(data.type);
            const img = stringValue(data.img);
            let uuid = stringValue(data.uuid);
            const getUuid = item.getUuid;
            if (!uuid && typeof getUuid === "function") {
              try {
                uuid = stringValue(await getUuid.call(raw, entryId));
              } catch {
                // A public helper failure must not erase an otherwise addressable index entry.
              }
            }
            return {
              id: entryId,
              uuid: uuid ?? `Compendium.${id}.${type}.${entryId}`,
              type,
              ...(name ? { name } : {}),
              ...(subtype ? { subtype } : {}),
              ...(img ? { img } : {}),
            };
          }),
        );
      },
      getDocuments: async () => values(await call(raw, "getDocuments")).map(wrapDocument),
      createDocument: async (data) => {
        if (!writable) throw new Error(writeReason ?? "The compendium is not writable");
        const created = await call(documentClass, "create", data, {
          pack: id,
          renderSheet: false,
        });
        if (!created)
          throw new Error(`Foundry did not return the created ${type} compendium entry`);
        return wrapDocument(created);
      },
    };
  }

  async #validateCandidate(candidate: unknown, type: string): Promise<RuntimeDocumentValidation> {
    const validate = record(candidate).validate;
    if (typeof validate !== "function") {
      return {
        schemaValidated: false,
        warnings: ["Foundry constructed the Document but exposed no side-effect-free validator"],
      };
    }
    try {
      const valid = await validate.call(candidate, {
        clean: true,
        fallback: false,
        joint: true,
        strict: true,
      });
      if (valid === false) throw new Error("validation returned false");
    } catch (error) {
      throw new Error(
        `Foundry schema rejected ${type}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return { schemaValidated: true, warnings: [] };
  }
}
