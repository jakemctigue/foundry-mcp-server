import type { EventEnvelope, JsonValue } from "@foundry-mcp/protocol";

export interface FoundryHooksApi {
  on(event: string, callback: (...args: unknown[]) => void): unknown;
  off(event: string, callback: (...args: unknown[]) => void): unknown;
}

export interface FoundryEventHookOptions {
  documentTypes: readonly string[];
  categories?: readonly string[];
  capturePrivateContent?: boolean;
  worldId?: string;
  now?: () => Date;
  publish: (event: Omit<EventEnvelope, "sequenceId">) => void;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" ? (value as UnknownRecord) : {};
}

function jsonValue(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item) => jsonValue(item, seen));
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  const item = record(value);
  if (typeof item.toObject === "function") {
    try {
      return jsonValue(item.toObject.call(value, false), seen);
    } catch {
      // Fall through to enumerable public fields.
    }
  }
  const output: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(item)) {
    if (typeof child !== "function") output[key] = jsonValue(child, seen);
  }
  return output;
}

function enabled(category: string, configured: readonly string[]): boolean {
  return configured.some((entry) =>
    entry.endsWith(".*")
      ? category.startsWith(entry.slice(0, -1))
      : category === entry || category.startsWith(`${entry}.`),
  );
}

function categoryFor(type: string, operation: string, privateContent: boolean): string {
  if (type === "JournalEntry" || type === "JournalEntryPage") return `journal.${operation}.${type}`;
  if (type === "Scene") return `scene.${operation}`;
  if (type === "Combat") return `combat.${operation}`;
  if (type === "ChatMessage") {
    return `chat.${privateContent ? "private" : "public"}.${operation}`;
  }
  return `document.${operation}.${type}`;
}

const OWNERSHIP_RESTRICTED_TYPES = new Set(["Actor", "Item", "JournalEntry", "JournalEntryPage"]);
const PUBLIC_OBSERVER_PERMISSION = 2;

function privateDocument(type: string, document: unknown): boolean {
  const item = record(document);
  if (type === "ChatMessage") {
    return item.blind === true || (Array.isArray(item.whisper) && item.whisper.length > 0);
  }
  const flags = record(record(item.flags).foundryMcp);
  if (flags.excludeFromIntelligence === true) return true;
  if (!OWNERSHIP_RESTRICTED_TYPES.has(type)) return false;
  const parent = record(item.parent);
  const ownership = record(
    Object.keys(record(item.ownership)).length > 0 ? item.ownership : parent.ownership,
  );
  const defaultPermission = ownership.default;
  return typeof defaultPermission !== "number" || defaultPermission < PUBLIC_OBSERVER_PERMISSION;
}

function publicMetadata(type: string, document: unknown, changes: unknown): JsonValue {
  const item = record(document);
  const metadata: Record<string, JsonValue> = { documentType: type };
  for (const key of ["id", "uuid", "name"] as const) {
    const value = item[key];
    if (typeof value === "string" && value.length > 0) metadata[key] = value;
  }
  return {
    document: metadata,
    changedFields: Object.keys(record(changes)).slice(0, 100),
  };
}

/** Emits real Foundry hooks through the shared ordered event publisher. */
export class FoundryEventHooks {
  readonly #listeners: Array<[string, (...args: unknown[]) => void]> = [];
  readonly #categories: readonly string[];
  readonly #now: () => Date;

  constructor(
    readonly hooks: FoundryHooksApi,
    readonly options: FoundryEventHookOptions,
  ) {
    this.#categories = options.categories ?? [
      "document.*",
      "journal.*",
      "scene.*",
      "combat.*",
      "chat.*",
    ];
    this.#now = options.now ?? (() => new Date());
    for (const type of [...new Set(options.documentTypes)]) {
      for (const operation of ["create", "update", "delete"] as const) {
        const event = `${operation}${type}`;
        const callback = (document: unknown, changes?: unknown) => {
          const privateContent = privateDocument(type, document);
          const category = categoryFor(type, operation, privateContent);
          if (!enabled(category, this.#categories)) return;
          if (privateContent && options.capturePrivateContent !== true) return;
          options.publish({
            category,
            payload:
              options.capturePrivateContent === true
                ? jsonValue({ document, changes })
                : publicMetadata(type, document, changes),
            emittedAt: this.#now().toISOString(),
            ...(options.worldId ? { worldId: options.worldId } : {}),
            ...(privateContent ? { privateContent: true } : {}),
          });
        };
        this.#listeners.push([event, callback]);
        hooks.on(event, callback);
      }
    }
  }

  close(): void {
    for (const [event, callback] of this.#listeners) this.hooks.off(event, callback);
    this.#listeners.length = 0;
  }
}
