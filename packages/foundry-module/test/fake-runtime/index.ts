import type { JsonObject, JsonValue } from "@foundry-mcp/protocol";
import type {
  FoundryRuntimeAdapter,
  RuntimeAuditEvent,
  RuntimeCompendium,
  RuntimeCompendiumIndexEntry,
  RuntimeDocument,
  RuntimeDocumentRegistration,
  RuntimeDocumentValidation,
  RuntimeSubtypeRegistration,
} from "../../src/runtime.js";

export const FakeRole = {
  NONE: 0,
  PLAYER: 1,
  TRUSTED: 2,
  ASSISTANT: 3,
  GAMEMASTER: 4,
} as const;

export type FakeRole = (typeof FakeRole)[keyof typeof FakeRole];

interface FakeSubtypeOptions {
  label?: string;
  minReadRole?: FakeRole;
  minCreateRole?: FakeRole;
  minUpdateRole?: FakeRole;
  reason?: string;
}

interface FakeRegistrationOptions {
  collection?: string;
  embedded?: boolean;
  parentTypes?: string[];
  schemaVersion?: string;
  minReadRole?: FakeRole;
  minCreateRole?: FakeRole;
  minUpdateRole?: FakeRole;
  reason?: string;
  subtypes?: Record<string, FakeSubtypeOptions>;
}

interface StoredRegistration extends Required<
  Pick<
    FakeRegistrationOptions,
    "embedded" | "parentTypes" | "schemaVersion" | "minReadRole" | "minCreateRole" | "minUpdateRole"
  >
> {
  type: string;
  collection?: string;
  reason?: string;
  subtypes: Map<
    string,
    Required<Pick<FakeSubtypeOptions, "minReadRole" | "minCreateRole" | "minUpdateRole">> &
      Pick<FakeSubtypeOptions, "label" | "reason">
  >;
}

interface FakeDocumentOptions {
  id?: string;
  parent?: FakeDocument;
  pack?: string;
  minReadRole?: FakeRole;
  minUpdateRole?: FakeRole;
  revision?: number;
}

function clone<T extends JsonValue | JsonObject>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepMerge(target: JsonObject, patch: JsonObject): JsonObject {
  const output = clone(target);
  for (const [key, value] of Object.entries(patch)) {
    const existing = output[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      output[key] = deepMerge(existing, value);
    } else {
      output[key] = clone(value);
    }
  }
  return output;
}

export class FakeDocument implements RuntimeDocument {
  readonly raw: unknown = this;
  readonly id: string;
  readonly documentName: string;
  readonly parent?: FakeDocument;
  readonly pack?: string;
  readonly subtype?: string;
  readonly minReadRole: FakeRole;
  readonly minUpdateRole: FakeRole;
  readonly schemaVersion: string;
  revision: number;
  data: JsonObject;

  constructor(
    readonly runtime: FakeFoundryRuntime,
    type: string,
    data: JsonObject,
    options: FakeDocumentOptions = {},
  ) {
    this.documentName = type;
    this.id = options.id ?? runtime.nextId(type);
    this.data = clone({ ...data, _id: options.id ?? this.id });
    if (typeof data.type === "string") this.subtype = data.type;
    if (options.parent) this.parent = options.parent;
    if (options.pack) this.pack = options.pack;
    this.minReadRole = options.minReadRole ?? FakeRole.PLAYER;
    this.minUpdateRole = options.minUpdateRole ?? FakeRole.GAMEMASTER;
    this.revision = options.revision ?? 1;
    this.schemaVersion = runtime.registration(type)?.schemaVersion ?? "fake-v1";
  }

  get uuid(): string {
    if (this.parent) return `${this.parent.uuid}.${this.documentName}.${this.id}`;
    if (this.pack) return `Compendium.${this.pack}.${this.documentName}.${this.id}`;
    return `${this.documentName}.${this.id}`;
  }

  get ownership(): unknown {
    return this.data.ownership ?? { default: this.minReadRole };
  }

  toObject(): JsonObject {
    return clone(this.data);
  }
}

class FakeCompendium implements RuntimeCompendium {
  #documents: FakeDocument[];

  constructor(
    readonly runtime: FakeFoundryRuntime,
    readonly id: string,
    readonly label: string,
    readonly type: string,
    readonly locked: boolean,
    readonly accessible: boolean,
    readonly configuredWritable: boolean,
    readonly configuredWriteReason: string | undefined,
    documents: FakeDocument[],
  ) {
    this.#documents = documents;
  }

  get documentCount(): number {
    return this.#documents.length;
  }

  get writable(): boolean {
    return this.accessible && !this.locked && this.configuredWritable;
  }

  get writeReason(): string | undefined {
    if (!this.accessible) return "The compendium is not accessible";
    if (this.locked) return "The compendium is locked";
    if (!this.configuredWritable)
      return this.configuredWriteReason ?? "The compendium denies document creation";
    return undefined;
  }

  async getIndex(): Promise<RuntimeCompendiumIndexEntry[]> {
    return this.#documents.map((document) => ({
      id: document.id,
      uuid: document.uuid,
      type: document.documentName,
      ...(typeof document.data.name === "string" ? { name: document.data.name } : {}),
      ...(document.subtype ? { subtype: document.subtype } : {}),
      ...(typeof document.data.img === "string" ? { img: document.data.img } : {}),
    }));
  }

  async getDocuments(): Promise<RuntimeDocument[]> {
    return [...this.#documents];
  }

  async createDocument(data: JsonObject): Promise<RuntimeDocument> {
    if (!this.writable) throw new Error(this.writeReason ?? "The compendium is not writable");
    const document = this.runtime.seedDocument(this.type, data, { pack: this.id });
    this.#documents.push(document);
    return document;
  }

  replaceDocuments(documents: FakeDocument[]): void {
    this.#documents = documents;
  }
}

interface FakeState {
  documents: Array<{
    type: string;
    data: JsonObject;
    id: string;
    parentUuid?: string;
    pack?: string;
    minReadRole: FakeRole;
    minUpdateRole: FakeRole;
    revision: number;
  }>;
  counters: Array<[string, number]>;
  auditLength: number;
}

export class FakeFoundryRuntime implements FoundryRuntimeAdapter {
  online = true;
  role: FakeRole;
  readonly auditEvents: RuntimeAuditEvent[] = [];
  readonly #registrations = new Map<string, StoredRegistration>();
  readonly #documents = new Map<string, FakeDocument>();
  readonly #roots = new Map<string, Map<string, FakeDocument>>();
  readonly #packs = new Map<string, FakeCompendium>();
  readonly #counters = new Map<string, number>();
  #createCalls = 0;
  #failCreateCall?: number;

  constructor(role: FakeRole = FakeRole.GAMEMASTER) {
    this.role = role;
  }

  isOnline(): boolean {
    return this.online;
  }

  registration(type: string): StoredRegistration | undefined {
    return this.#registrations.get(type);
  }

  registerDocumentType(type: string, options: FakeRegistrationOptions = {}): this {
    const subtypes = new Map<
      string,
      StoredRegistration["subtypes"] extends Map<string, infer V> ? V : never
    >();
    for (const [subtype, value] of Object.entries(options.subtypes ?? {})) {
      subtypes.set(subtype, {
        minReadRole: value.minReadRole ?? options.minReadRole ?? FakeRole.PLAYER,
        minCreateRole: value.minCreateRole ?? options.minCreateRole ?? FakeRole.GAMEMASTER,
        minUpdateRole: value.minUpdateRole ?? options.minUpdateRole ?? FakeRole.GAMEMASTER,
        ...(value.label ? { label: value.label } : {}),
        ...(value.reason ? { reason: value.reason } : {}),
      });
    }
    this.#registrations.set(type, {
      type,
      ...(options.collection ? { collection: options.collection } : {}),
      embedded: options.embedded ?? false,
      parentTypes: [...(options.parentTypes ?? [])],
      schemaVersion: options.schemaVersion ?? "fake-v1",
      minReadRole: options.minReadRole ?? FakeRole.PLAYER,
      minCreateRole: options.minCreateRole ?? FakeRole.GAMEMASTER,
      minUpdateRole: options.minUpdateRole ?? FakeRole.GAMEMASTER,
      ...(options.reason ? { reason: options.reason } : {}),
      subtypes,
    });
    if (options.collection || !(options.embedded ?? false)) this.#roots.set(type, new Map());
    return this;
  }

  nextId(type: string): string {
    const next = (this.#counters.get(type) ?? 0) + 1;
    this.#counters.set(type, next);
    return `${type.toLocaleLowerCase()}-${next.toString().padStart(4, "0")}`;
  }

  seedDocument(
    type: string,
    data: JsonObject,
    options: Omit<FakeDocumentOptions, "parent"> & { parentUuid?: string } = {},
  ): FakeDocument {
    const registration = this.#registrations.get(type);
    if (!registration) throw new Error(`Type ${type} is not registered`);
    const parent = options.parentUuid ? this.#documents.get(options.parentUuid) : undefined;
    if (options.parentUuid && !parent)
      throw new Error(`Parent ${options.parentUuid} does not exist`);
    const document = new FakeDocument(this, type, data, {
      ...(options.id ? { id: options.id } : {}),
      ...(parent ? { parent } : {}),
      ...(options.pack ? { pack: options.pack } : {}),
      ...(options.minReadRole !== undefined ? { minReadRole: options.minReadRole } : {}),
      ...(options.minUpdateRole !== undefined ? { minUpdateRole: options.minUpdateRole } : {}),
      ...(options.revision !== undefined ? { revision: options.revision } : {}),
    });
    this.#documents.set(document.uuid, document);
    if (!parent && !options.pack) {
      const collection = this.#roots.get(type) ?? new Map<string, FakeDocument>();
      collection.set(document.id, document);
      this.#roots.set(type, collection);
    }
    return document;
  }

  addCompendium(options: {
    id: string;
    label: string;
    type: string;
    locked?: boolean;
    accessible?: boolean;
    writable?: boolean;
    writeReason?: string;
    documents: JsonObject[];
  }): this {
    const documents = options.documents.map((data) =>
      this.seedDocument(options.type, data, { pack: options.id }),
    );
    this.#packs.set(
      options.id,
      new FakeCompendium(
        this,
        options.id,
        options.label,
        options.type,
        options.locked ?? false,
        options.accessible ?? true,
        options.writable ?? true,
        options.writeReason,
        documents,
      ),
    );
    return this;
  }

  failCreateOnCall(callNumber: number): void {
    this.#failCreateCall = callNumber;
    this.#createCalls = 0;
  }

  async listDocumentRegistrations(): Promise<RuntimeDocumentRegistration[]> {
    return [...this.#registrations.values()].map((registration) => {
      const readable = this.role >= registration.minReadRole;
      const creatable = this.role >= registration.minCreateRole;
      const updatable = this.role >= registration.minUpdateRole;
      const reason =
        registration.reason ??
        (!readable
          ? "Document type is hidden from this role"
          : !creatable
            ? "Role cannot create this Document type"
            : undefined);
      const subtypes: RuntimeSubtypeRegistration[] = [...registration.subtypes.entries()].map(
        ([subtype, value]) => {
          const subtypeReadable = this.role >= value.minReadRole;
          const subtypeCreatable = this.role >= value.minCreateRole;
          const subtypeUpdatable = this.role >= value.minUpdateRole;
          const subtypeReason =
            value.reason ??
            (!subtypeReadable
              ? "Subtype is hidden from this role"
              : !subtypeCreatable
                ? "Role cannot create this subtype"
                : undefined);
          return {
            subtype,
            ...(value.label ? { label: value.label } : {}),
            readable: subtypeReadable,
            creatable: subtypeCreatable,
            updatable: subtypeUpdatable,
            ...(subtypeReason ? { reason: subtypeReason } : {}),
          };
        },
      );
      return {
        type: registration.type,
        ...(registration.collection ? { collection: registration.collection } : {}),
        embedded: registration.embedded,
        parentTypes: [...registration.parentTypes],
        schemaVersion: registration.schemaVersion,
        readable,
        creatable,
        updatable,
        ...(reason ? { reason } : {}),
        subtypes,
      };
    });
  }

  async listRootDocuments(type: string): Promise<RuntimeDocument[]> {
    return [...(this.#roots.get(type)?.values() ?? [])];
  }

  parseUuid(uuid: string): { uuid: string } {
    if (!/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+$/.test(uuid)) throw new Error("Invalid UUID");
    return { uuid };
  }

  async fromUuid(uuid: string): Promise<RuntimeDocument | null> {
    return this.#documents.get(uuid) ?? null;
  }

  async listEmbeddedDocuments(
    parent: RuntimeDocument,
    embeddedType?: string,
  ): Promise<RuntimeDocument[]> {
    return [...this.#documents.values()].filter(
      (document) =>
        document.parent?.uuid === parent.uuid &&
        (!embeddedType || document.documentName === embeddedType),
    );
  }

  async createDocument(
    type: string,
    data: JsonObject,
    parent?: RuntimeDocument,
  ): Promise<RuntimeDocument> {
    this.#createCalls += 1;
    if (this.#failCreateCall === this.#createCalls) throw new Error("Injected create failure");
    return this.seedDocument(type, data, { ...(parent ? { parentUuid: parent.uuid } : {}) });
  }

  async validateDocumentCreate(
    _type: string,
    data: JsonObject,
    _parent?: RuntimeDocument,
    _pack?: RuntimeCompendium,
  ): Promise<RuntimeDocumentValidation> {
    this.#validateData(data);
    return { schemaValidated: true, warnings: [] };
  }

  async validateDocumentUpdate(
    document: RuntimeDocument,
    data: JsonObject,
  ): Promise<RuntimeDocumentValidation> {
    this.#validateData(deepMerge(clone(document.toObject() as JsonObject), data));
    return { schemaValidated: true, warnings: [] };
  }

  async updateDocument(document: RuntimeDocument, data: JsonObject): Promise<RuntimeDocument> {
    const stored = this.#documents.get(document.uuid);
    if (!stored) throw new Error("Document disappeared during update");
    stored.data = deepMerge(stored.data, data);
    stored.revision += 1;
    return stored;
  }

  async deleteDocument(document: RuntimeDocument): Promise<void> {
    const descendants = [...this.#documents.values()].filter(
      (candidate) => candidate.parent?.uuid === document.uuid,
    );
    for (const descendant of descendants) await this.deleteDocument(descendant);
    this.#documents.delete(document.uuid);
    this.#roots.get(document.documentName)?.delete(document.id);
  }

  canRead(document: RuntimeDocument): boolean {
    return document instanceof FakeDocument && this.role >= document.minReadRole;
  }

  canCreate(
    type: string,
    subtype?: string,
    parent?: RuntimeDocument,
  ): { allowed: boolean; reason?: string } {
    const registration = this.#registrations.get(type);
    if (!registration) return { allowed: false, reason: `Type ${type} is not registered` };
    if (parent && !registration.parentTypes.includes(parent.documentName)) {
      return { allowed: false, reason: `${type} cannot be embedded in ${parent.documentName}` };
    }
    const subtypeRegistration = subtype ? registration.subtypes.get(subtype) : undefined;
    if (subtype && registration.subtypes.size > 0 && !subtypeRegistration) {
      return { allowed: false, reason: `Subtype ${subtype} is not registered` };
    }
    const required = subtypeRegistration?.minCreateRole ?? registration.minCreateRole;
    return this.role >= required
      ? { allowed: true }
      : {
          allowed: false,
          reason:
            subtypeRegistration?.reason ??
            registration.reason ??
            "Role cannot create this Document",
        };
  }

  canUpdate(document: RuntimeDocument): { allowed: boolean; reason?: string } {
    if (!(document instanceof FakeDocument))
      return { allowed: false, reason: "Unknown fake Document" };
    const registration = this.#registrations.get(document.documentName);
    const subtypeRegistration = document.subtype
      ? registration?.subtypes.get(document.subtype)
      : undefined;
    const required = Math.max(
      document.minUpdateRole,
      subtypeRegistration?.minUpdateRole ?? registration?.minUpdateRole ?? FakeRole.GAMEMASTER,
    );
    return this.role >= required
      ? { allowed: true }
      : {
          allowed: false,
          reason:
            subtypeRegistration?.reason ??
            registration?.reason ??
            "Role cannot update this Document",
        };
  }

  async listCompendiums(): Promise<RuntimeCompendium[]> {
    return [...this.#packs.values()];
  }

  async getCompendium(packId: string): Promise<RuntimeCompendium | null> {
    return this.#packs.get(packId) ?? null;
  }

  audit(event: RuntimeAuditEvent): void {
    this.auditEvents.push(clone(event as unknown as JsonObject) as unknown as RuntimeAuditEvent);
  }

  snapshotState(): FakeState {
    return {
      documents: [...this.#documents.values()].map((document) => ({
        type: document.documentName,
        data: document.toObject(),
        id: document.id,
        ...(document.parent ? { parentUuid: document.parent.uuid } : {}),
        ...(document.pack ? { pack: document.pack } : {}),
        minReadRole: document.minReadRole,
        minUpdateRole: document.minUpdateRole,
        revision: document.revision,
      })),
      counters: [...this.#counters.entries()],
      auditLength: this.auditEvents.length,
    };
  }

  restoreState(snapshot: unknown): void {
    const state = snapshot as FakeState;
    this.#documents.clear();
    for (const collection of this.#roots.values()) collection.clear();
    this.#counters.clear();
    for (const [key, value] of state.counters) this.#counters.set(key, value);
    const pending = [...state.documents];
    while (pending.length > 0) {
      const index = pending.findIndex(
        (document) => !document.parentUuid || this.#documents.has(document.parentUuid),
      );
      if (index < 0) throw new Error("Fake state contains an unresolved parent cycle");
      const [document] = pending.splice(index, 1);
      if (!document) break;
      this.seedDocument(document.type, document.data, {
        id: document.id,
        ...(document.parentUuid ? { parentUuid: document.parentUuid } : {}),
        ...(document.pack ? { pack: document.pack } : {}),
        minReadRole: document.minReadRole,
        minUpdateRole: document.minUpdateRole,
        revision: document.revision,
      });
    }
    for (const [packId, pack] of this.#packs) {
      pack.replaceDocuments(
        [...this.#documents.values()].filter((document) => document.pack === packId),
      );
    }
    this.auditEvents.splice(state.auditLength);
  }

  #validateData(data: JsonObject): void {
    if (typeof data.name !== "string" || data.name.trim().length === 0) {
      throw new Error("Fake Foundry schema requires a non-empty Document name");
    }
  }
}

export function createRichFakeRuntime(role: FakeRole = FakeRole.GAMEMASTER): FakeFoundryRuntime {
  return new FakeFoundryRuntime(role)
    .registerDocumentType("Actor", {
      collection: "actors",
      subtypes: {
        stormborn: { label: "Stormborn" },
        clockwork: { label: "Clockwork" },
      },
    })
    .registerDocumentType("Item", {
      collection: "items",
      embedded: true,
      parentTypes: ["Actor"],
      subtypes: {
        rune: { label: "Rune" },
        relic: { label: "Relic" },
      },
    })
    .registerDocumentType("JournalEntry", { collection: "journal" })
    .registerDocumentType("Folder", { collection: "folders" })
    .registerDocumentType("JournalEntryPage", {
      embedded: true,
      parentTypes: ["JournalEntry"],
    })
    .registerDocumentType("Scene", { collection: "scenes" })
    .registerDocumentType("RollTable", { collection: "tables" })
    .registerDocumentType("TableResult", { embedded: true, parentTypes: ["RollTable"] })
    .registerDocumentType("Playlist", { collection: "playlists" })
    .registerDocumentType("PlaylistSound", { embedded: true, parentTypes: ["Playlist"] })
    .registerDocumentType("Cards", { collection: "cards" })
    .registerDocumentType("Card", { embedded: true, parentTypes: ["Cards"] })
    .registerDocumentType("Macro", { collection: "macros" })
    .registerDocumentType("Attachment", { embedded: true, parentTypes: ["Item"] })
    .registerDocumentType("Annotation", { embedded: true, parentTypes: ["Attachment"] });
}
