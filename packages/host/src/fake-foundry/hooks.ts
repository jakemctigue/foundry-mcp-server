import type { EventEnvelope, JsonValue } from "@foundry-mcp/protocol";

export type HookCallback = (...args: unknown[]) => void;

/** Mirrors Foundry's global `Hooks.on` / `Hooks.callAll`. */
export class FakeHooks {
  private listeners = new Map<string, HookCallback[]>();

  on(event: string, callback: HookCallback): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(callback);
    this.listeners.set(event, existing);
  }

  off(event: string, callback: HookCallback): void {
    const existing = this.listeners.get(event);
    if (!existing) {
      return;
    }
    this.listeners.set(
      event,
      existing.filter((cb) => cb !== callback),
    );
  }

  callAll(event: string, ...args: unknown[]): void {
    const existing = this.listeners.get(event) ?? [];
    for (const callback of existing) {
      callback(...args);
    }
  }
}

export interface FakeHookEventBridgeOptions {
  categories?: readonly string[];
  capturePrivateContent?: boolean;
  firstSequenceId?: number;
  now?: () => Date;
  onEvent: (event: EventEnvelope) => void;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" ? (value as UnknownRecord) : {};
}

function documentType(value: unknown): string {
  const item = record(value);
  const ctor = record(item.constructor);
  return String(item.documentName ?? ctor.documentName ?? item.type ?? "Document");
}

function jsonValue(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item) => jsonValue(item, seen));
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  const item = record(value);
  const toObject = item.toObject;
  if (typeof toObject === "function") {
    try {
      return jsonValue(toObject.call(value, false), seen);
    } catch {
      // Fall through to stable public fields used by the fixture.
    }
  }
  const output: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(item)) {
    if (typeof child !== "function") output[key] = jsonValue(child, seen);
  }
  return output;
}

function categoryEnabled(category: string, configured: readonly string[]): boolean {
  return configured.some((entry) =>
    entry.endsWith(".*")
      ? category.startsWith(entry.slice(0, -1))
      : category === entry || category.startsWith(`${entry}.`),
  );
}

/**
 * Mocked Foundry hook publisher used by integration tests. Its hook names and
 * payload shapes intentionally mirror the real companion publisher.
 */
export class FakeHookEventBridge {
  readonly #callbacks: Array<[string, HookCallback]> = [];
  readonly #categories: readonly string[];
  readonly #capturePrivateContent: boolean;
  readonly #now: () => Date;
  readonly #onEvent: (event: EventEnvelope) => void;
  #nextSequenceId: number;

  constructor(
    readonly hooks: FakeHooks,
    options: FakeHookEventBridgeOptions,
  ) {
    this.#categories =
      options.categories ?? ["document.*", "journal.*", "scene.*", "combat.*", "chat.*"];
    this.#capturePrivateContent = options.capturePrivateContent === true;
    this.#nextSequenceId = options.firstSequenceId ?? 1;
    this.#now = options.now ?? (() => new Date());
    this.#onEvent = options.onEvent;
    this.#listen("createDocument", (document) => this.#document("create", document));
    this.#listen("updateDocument", (document, changes) =>
      this.#document("update", document, changes),
    );
    this.#listen("deleteDocument", (document) => this.#document("delete", document));
    for (const operation of ["create", "update", "delete"] as const) {
      for (const type of ["JournalEntry", "JournalEntryPage"] as const) {
        this.#listen(`${operation}${type}`, (document, changes) =>
          this.#emit(`journal.${operation}.${type}`, { document, changes }),
        );
      }
      this.#listen(`${operation}Scene`, (document, changes) =>
        this.#emit(`scene.${operation}`, { document, changes }),
      );
      this.#listen(`${operation}Combat`, (document, changes) =>
        this.#emit(`combat.${operation}`, { document, changes }),
      );
    }
    this.#listen("createChatMessage", (document) => {
      const item = record(document);
      const privateContent =
        item.blind === true ||
        (Array.isArray(item.whisper) && item.whisper.length > 0) ||
        record(item.flags).private === true;
      this.#emit(`chat.${privateContent ? "private" : "public"}.create`, { document }, privateContent);
    });
  }

  close(): void {
    for (const [event, callback] of this.#callbacks) this.hooks.off(event, callback);
    this.#callbacks.length = 0;
  }

  #listen(event: string, callback: HookCallback): void {
    this.#callbacks.push([event, callback]);
    this.hooks.on(event, callback);
  }

  #document(operation: "create" | "update" | "delete", document: unknown, changes?: unknown): void {
    this.#emit(`document.${operation}.${documentType(document)}`, { document, changes });
  }

  #emit(category: string, payload: unknown, privateContent = false): void {
    if (!categoryEnabled(category, this.#categories)) return;
    if (privateContent && !this.#capturePrivateContent) return;
    this.#onEvent({
      sequenceId: this.#nextSequenceId,
      category,
      payload: jsonValue(payload),
      emittedAt: this.#now().toISOString(),
      ...(privateContent ? { privateContent: true } : {}),
    });
    this.#nextSequenceId += 1;
  }
}
