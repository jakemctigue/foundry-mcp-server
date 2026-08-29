import crypto from "node:crypto";

import {
  CompendiumDocumentsListOutput,
  CompendiumsListOutput,
  DocumentsGetOutput,
  DocumentsListOutput,
  DocumentsTypesOutput,
  EmbeddedDocumentsListOutput,
  type DocumentView,
  type IntelligenceObjectSnapshot,
  type IntelligenceStatusOutput,
  type JsonValue,
} from "@foundry-mcp/protocol";
import type Database from "better-sqlite3";

import { redactSecretText, redactSecrets } from "../security/redaction.js";
import type { EventCaptureOptions } from "./event-ledger.js";

const DEFAULT_DOCUMENT_BUDGET = 500;
const PAGE_SIZE = 50;
const MAX_TASKS = 2_000;
const MAX_SNAPSHOT_BYTES = 256 * 1_024;
const PUBLIC_OWNERSHIP_LEVEL = 1;

type ReconcileReason = "initial" | "reconnect" | "periodic" | "manual";
type TaskKind = "root" | "embedded" | "compendium";
type UnknownRecord = Record<string, unknown>;

export interface ReconciliationBridge {
  request(
    connectionId: string,
    method: string,
    params?: Record<string, JsonValue>,
    requestId?: string,
    options?: { signal?: AbortSignal },
  ): Promise<JsonValue>;
}

export interface ReconcileInvocationOptions {
  signal?: AbortSignal;
}

export interface ReconcileOptions extends EventCaptureOptions {
  documentBudget?: number;
  now?: () => Date;
}

interface JobRow {
  connection_id: string;
  run_id: string;
  status: "running" | "incomplete" | "complete" | "failed";
  reason: string;
  started_at: string;
  updated_at: string;
  last_completed_at: string | null;
  scanned_count: number;
  changed_count: number;
  private_filtered_count: number;
  queue_depth: number;
  gap: number;
  truncated: number;
  last_error: string | null;
}

interface TaskRow {
  task_key: string;
  task_kind: TaskKind;
  params_json: string;
  cursor: string | null;
}

interface PageResult {
  scanned: number;
  changed: number;
  privateFiltered: number;
  truncated: boolean;
  nextCursor?: string;
  lastError?: string;
}

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" ? (value as UnknownRecord) : {};
}

function positiveBudget(value: number | undefined): number {
  const budget = value ?? DEFAULT_DOCUMENT_BUDGET;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 10_000) {
    throw new Error("documentBudget must be an integer from 1 to 10000");
  }
  return budget;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function privacyFlag(data: UnknownRecord): boolean {
  if (data["private"] === true) return true;
  const whisper = data["whisper"];
  if (Array.isArray(whisper) && whisper.length > 0) return true;
  const flags = record(data["flags"]);
  return record(flags["foundry-mcp"])["private"] === true;
}

function isPrivateDocument(document: DocumentView): boolean {
  const defaultOwnership = document.ownershipSummary["default"];
  return (
    privacyFlag(document.data) ||
    (typeof defaultOwnership === "number" && defaultOwnership < PUBLIC_OWNERSHIP_LEVEL)
  );
}

function requestValue<T>(raw: unknown, parse: (value: unknown) => T, method: string): T {
  let value = raw;
  const result = record(raw);
  if (result["ok"] === false) {
    const error = record(result["error"]);
    throw new Error(typeof error["message"] === "string" ? error["message"] : `${method} failed`);
  }
  if (result["ok"] === true) value = result["value"];
  try {
    return parse(value);
  } catch (error) {
    throw new Error(`Foundry returned malformed ${method} data`, { cause: error });
  }
}

function safeError(error: unknown): string {
  return redactSecretText(error instanceof Error ? error.message : "reconciliation failed").slice(
    0,
    2_000,
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("intelligence reconciliation cancelled");
}

function taskKey(kind: TaskKind, value: string): string {
  return `${kind}:${sha256(value)}`;
}

function queueDepth(db: Database.Database, connectionId: string, runId: string): number {
  return (
    db
      .prepare(
        `SELECT count(*) AS count FROM reconciliation_tasks
         WHERE connection_id = ? AND run_id = ? AND status <> 'complete'`,
      )
      .get(connectionId, runId) as { count: number }
  ).count;
}

function addTask(
  db: Database.Database,
  connectionId: string,
  runId: string,
  kind: TaskKind,
  keyValue: string,
  params: Record<string, JsonValue>,
  now: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO reconciliation_tasks
      (connection_id, run_id, task_key, task_kind, params_json, status, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(connectionId, runId, taskKey(kind, keyValue), kind, JSON.stringify(params), now);
}

function nextTask(db: Database.Database, connectionId: string, runId: string): TaskRow | undefined {
  return db
    .prepare(
      `SELECT task_key, task_kind, params_json, cursor
       FROM reconciliation_tasks
       WHERE connection_id = ? AND run_id = ? AND status <> 'complete'
       ORDER BY task_key ASC LIMIT 1`,
    )
    .get(connectionId, runId) as TaskRow | undefined;
}

function compactSnapshot(document: DocumentView): {
  data: IntelligenceObjectSnapshot["data"];
  truncated: boolean;
} {
  const redacted = redactSecrets(document.data, {
    maxDepth: 12,
    maxCollectionItems: 1_000,
  }) as IntelligenceObjectSnapshot["data"];
  const serialized = canonicalJson(redacted);
  const redactionTruncated = serialized.includes('"[TRUNCATED]"');
  if (Buffer.byteLength(serialized, "utf8") <= MAX_SNAPSHOT_BYTES) {
    return { data: redacted, truncated: redactionTruncated };
  }
  return {
    data: {
      _reconciliationTruncated: true,
      ...(typeof document.data["name"] === "string" ? { name: document.data["name"] } : {}),
      ...(typeof document.data["type"] === "string" ? { type: document.data["type"] } : {}),
    },
    truncated: true,
  };
}

function upsertSnapshot(
  db: Database.Database,
  connectionId: string,
  runId: string,
  document: DocumentView,
  capturePrivateContent: boolean,
  now: string,
): { changed: boolean; privateFiltered: boolean; truncated: boolean } {
  const objectId = sha256(`${connectionId}\0${document.uuid}`);
  if (capturePrivateContent !== true && isPrivateDocument(document)) {
    db.prepare("DELETE FROM intelligence_objects WHERE connection_id = ? AND object_id = ?").run(
      connectionId,
      objectId,
    );
    return { changed: false, privateFiltered: true, truncated: false };
  }

  const compact = compactSnapshot(document);
  const snapshotWithoutHash = {
    source: "snapshot" as const,
    objectId,
    connectionId,
    uuid: document.uuid,
    documentType: document.type,
    ...(document.subtype === undefined ? {} : { subtype: document.subtype }),
    ...(document.name === undefined ? {} : { name: document.name }),
    ...(document.parentUuid === undefined ? {} : { parentUuid: document.parentUuid }),
    ...(document.packId === undefined ? {} : { packId: document.packId }),
    data: compact.data,
  };
  const snapshotHash = sha256(canonicalJson(snapshotWithoutHash));
  const snapshot: IntelligenceObjectSnapshot = {
    ...snapshotWithoutHash,
    snapshotHash,
    reconciledAt: now,
  };
  const previous = db
    .prepare(
      `SELECT snapshot_hash FROM intelligence_objects
       WHERE connection_id = ? AND object_id = ?`,
    )
    .get(connectionId, objectId) as { snapshot_hash: string } | undefined;
  const searchText = [
    document.type,
    document.subtype ?? "",
    document.name ?? "",
    document.uuid,
    JSON.stringify(compact.data),
  ]
    .join(" ")
    .toLowerCase()
    .slice(0, 64 * 1_024);
  db.prepare(
    `INSERT INTO intelligence_objects
      (connection_id, object_id, uuid, document_type, subtype, name, parent_uuid, pack_id,
       snapshot_hash, snapshot_json, search_text, first_seen_at, last_seen_at, last_seen_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(connection_id, object_id) DO UPDATE SET
       uuid = excluded.uuid,
       document_type = excluded.document_type,
       subtype = excluded.subtype,
       name = excluded.name,
       parent_uuid = excluded.parent_uuid,
       pack_id = excluded.pack_id,
       snapshot_hash = excluded.snapshot_hash,
       snapshot_json = excluded.snapshot_json,
       search_text = excluded.search_text,
       last_seen_at = excluded.last_seen_at,
       last_seen_run_id = excluded.last_seen_run_id`,
  ).run(
    connectionId,
    objectId,
    document.uuid,
    document.type,
    document.subtype ?? null,
    document.name ?? null,
    document.parentUuid ?? null,
    document.packId ?? null,
    snapshotHash,
    JSON.stringify(snapshot),
    searchText,
    now,
    now,
    runId,
  );
  return {
    changed: previous?.snapshot_hash !== snapshotHash,
    privateFiltered: false,
    truncated: compact.truncated,
  };
}

export function getIntelligenceStatus(
  db: Database.Database,
  connectionId: string,
): IntelligenceStatusOutput {
  const job = db
    .prepare("SELECT * FROM reconciliation_jobs WHERE connection_id = ?")
    .get(connectionId) as JobRow | undefined;
  const event = db
    .prepare("SELECT max(received_at) AS last_event_at FROM events WHERE connection_id = ?")
    .get(connectionId) as { last_event_at: string | null };
  const retention = db
    .prepare(
      "SELECT last_run_at, removed_events FROM intelligence_retention_state WHERE singleton = 1",
    )
    .get() as { last_run_at: string; removed_events: number } | undefined;
  const indexedObjects = (
    db
      .prepare("SELECT count(*) AS count FROM intelligence_objects WHERE connection_id = ?")
      .get(connectionId) as { count: number }
  ).count;
  const pendingReceipts = (
    db
      .prepare("SELECT count(*) AS count FROM event_receipts WHERE connection_id = ?")
      .get(connectionId) as { count: number }
  ).count;
  return {
    connectionId,
    status: job?.status ?? "never",
    ...(job ? { lastAttemptAt: job.started_at } : {}),
    ...(job?.last_completed_at ? { lastReconcileAt: job.last_completed_at } : {}),
    ...(event.last_event_at ? { lastEventAt: event.last_event_at } : {}),
    ...(retention ? { lastRetentionAt: retention.last_run_at } : {}),
    queueDepth: (job?.queue_depth ?? 0) + pendingReceipts,
    indexedObjects,
    scannedObjects: job?.scanned_count ?? 0,
    changedObjects: job?.changed_count ?? 0,
    privateFilteredObjects: job?.private_filtered_count ?? 0,
    retentionRemovedEvents: retention?.removed_events ?? 0,
    gap: job?.gap === 1 || pendingReceipts > 0,
    truncated: job?.truncated === 1,
    ...(job?.last_error ? { lastError: job.last_error } : {}),
  };
}

/** Durable, bounded reconciliation over the companion's existing read-only document APIs. */
export class IntelligenceReconciler {
  readonly #active = new Map<
    string,
    { promise: Promise<IntelligenceStatusOutput>; controller: AbortController }
  >();
  readonly #now: () => Date;
  readonly #documentBudget: number;

  constructor(
    readonly db: Database.Database,
    readonly bridge: ReconciliationBridge,
    readonly options: ReconcileOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#documentBudget = positiveBudget(options.documentBudget);
  }

  reconcile(
    connectionId: string,
    reason: ReconcileReason = "manual",
    invocation: ReconcileInvocationOptions = {},
  ): Promise<IntelligenceStatusOutput> {
    const existing = this.#active.get(connectionId);
    if (existing) {
      const removeAbortForwarder = this.#forwardAbort(invocation.signal, existing.controller);
      return existing.promise.finally(removeAbortForwarder);
    }
    const controller = new AbortController();
    const removeAbortForwarder = this.#forwardAbort(invocation.signal, controller);
    const operation = this.#reconcile(connectionId, reason, controller.signal).finally(() => {
      removeAbortForwarder();
      this.#active.delete(connectionId);
    });
    this.#active.set(connectionId, { promise: operation, controller });
    return operation;
  }

  #forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
    if (!signal) return () => undefined;
    const abort = (): void => controller.abort(signal.reason);
    if (signal.aborted) {
      abort();
      return () => undefined;
    }
    signal.addEventListener("abort", abort, { once: true });
    return () => signal.removeEventListener("abort", abort);
  }

  async #request<T>(
    connectionId: string,
    method: string,
    params: Record<string, JsonValue>,
    parse: (value: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    throwIfAborted(signal);
    return requestValue(
      await this.bridge.request(connectionId, method, params, undefined, signal ? { signal } : {}),
      parse,
      method,
    );
  }

  async #newRun(
    connectionId: string,
    reason: ReconcileReason,
    signal?: AbortSignal,
  ): Promise<JobRow> {
    throwIfAborted(signal);
    const now = this.#now().toISOString();
    const runId = crypto.randomUUID();
    const previous = this.db
      .prepare("SELECT last_completed_at FROM reconciliation_jobs WHERE connection_id = ?")
      .get(connectionId) as { last_completed_at: string | null } | undefined;
    this.db.prepare("DELETE FROM reconciliation_tasks WHERE connection_id = ?").run(connectionId);
    this.db
      .prepare(
        `INSERT INTO reconciliation_jobs
        (connection_id, run_id, status, reason, started_at, updated_at, last_completed_at,
         scanned_count, changed_count, private_filtered_count, queue_depth, gap, truncated)
       VALUES (?, ?, 'running', ?, ?, ?, ?, 0, 0, 0, 0, 0, 0)
       ON CONFLICT(connection_id) DO UPDATE SET
         run_id = excluded.run_id,
         status = 'running',
         reason = excluded.reason,
         started_at = excluded.started_at,
         updated_at = excluded.updated_at,
         scanned_count = 0,
         changed_count = 0,
         private_filtered_count = 0,
         queue_depth = 0,
         gap = 0,
         truncated = 0,
         last_error = NULL`,
      )
      .run(connectionId, runId, reason, now, now, previous?.last_completed_at ?? null);

    const types = await this.#request(
      connectionId,
      "documents.types",
      { connectionId },
      (value) => DocumentsTypesOutput.parse(value),
      signal,
    );
    const compendiums = await this.#request(
      connectionId,
      "compendiums.list",
      { connectionId },
      (value) => CompendiumsListOutput.parse(value),
      signal,
    );
    let taskCount = 0;
    let truncated = false;
    // A Foundry Document type can have both a world collection and embedded parents (Items are
    // the common example). Asking the runtime for root documents is safe and may return an empty
    // page, so never skip a readable type merely because it is also embeddable.
    for (const type of types.types.filter((entry) => entry.readable)) {
      if (taskCount >= MAX_TASKS) {
        truncated = true;
        break;
      }
      addTask(this.db, connectionId, runId, "root", type.type, { type: type.type }, now);
      taskCount += 1;
    }
    for (const pack of compendiums.packs) {
      if (taskCount >= MAX_TASKS) {
        truncated = true;
        break;
      }
      addTask(this.db, connectionId, runId, "compendium", pack.id, { packId: pack.id }, now);
      taskCount += 1;
    }
    this.db
      .prepare(
        `UPDATE reconciliation_jobs SET queue_depth = ?, gap = ?, truncated = ?, updated_at = ?
       WHERE connection_id = ?`,
      )
      .run(taskCount, truncated ? 1 : 0, truncated ? 1 : 0, now, connectionId);
    return this.db
      .prepare("SELECT * FROM reconciliation_jobs WHERE connection_id = ?")
      .get(connectionId) as JobRow;
  }

  async #resumeOrStart(
    connectionId: string,
    reason: ReconcileReason,
    signal?: AbortSignal,
  ): Promise<JobRow> {
    throwIfAborted(signal);
    const existing = this.db
      .prepare("SELECT * FROM reconciliation_jobs WHERE connection_id = ?")
      .get(connectionId) as JobRow | undefined;
    if (existing && existing.status !== "complete") {
      const depth = queueDepth(this.db, connectionId, existing.run_id);
      if (depth > 0) {
        const now = this.#now().toISOString();
        this.db
          .prepare(
            `UPDATE reconciliation_tasks SET status = 'pending', updated_at = ?
           WHERE connection_id = ? AND run_id = ? AND status = 'running'`,
          )
          .run(now, connectionId, existing.run_id);
        this.db
          .prepare(
            `UPDATE reconciliation_jobs
            SET status = 'running', reason = ?, started_at = ?, updated_at = ?,
                queue_depth = ?, last_error = NULL
            WHERE connection_id = ?`,
          )
          .run(reason, now, now, depth, connectionId);
        return { ...existing, status: "running", reason, updated_at: now, queue_depth: depth };
      }
    }
    return this.#newRun(connectionId, reason, signal);
  }

  async #document(
    connectionId: string,
    runId: string,
    uuid: string,
    now: string,
    signal?: AbortSignal,
  ): Promise<{ changed: boolean; privateFiltered: boolean; truncated: boolean }> {
    const document = await this.#request(
      connectionId,
      "documents.get",
      { connectionId, uuid },
      (value) => DocumentsGetOutput.parse(value),
      signal,
    );
    return upsertSnapshot(
      this.db,
      connectionId,
      runId,
      document,
      this.options.capturePrivateContent === true,
      now,
    );
  }

  async #processTask(
    connectionId: string,
    runId: string,
    task: TaskRow,
    budget: number,
    signal?: AbortSignal,
  ): Promise<PageResult> {
    throwIfAborted(signal);
    const now = this.#now().toISOString();
    const params = JSON.parse(task.params_json) as Record<string, JsonValue>;
    const pageSize = Math.min(PAGE_SIZE, budget);
    const result: PageResult = { scanned: 0, changed: 0, privateFiltered: 0, truncated: false };
    if (task.task_kind === "root") {
      const page = await this.#request(
        connectionId,
        "documents.list",
        {
          connectionId,
          type: String(params["type"]),
          pageSize,
          sort: { field: "id", direction: "asc" },
          ...(task.cursor ? { cursor: task.cursor } : {}),
        },
        (value) => DocumentsListOutput.parse(value),
        signal,
      );
      for (const summary of page.items) {
        throwIfAborted(signal);
        result.scanned += 1;
        let traverseChildren = false;
        try {
          const stored = await this.#document(connectionId, runId, summary.uuid, now, signal);
          if (stored.changed) result.changed += 1;
          if (stored.privateFiltered) result.privateFiltered += 1;
          if (stored.truncated) result.truncated = true;
          traverseChildren = !stored.privateFiltered;
        } catch (error) {
          if (signal?.aborted) throw error;
          result.truncated = true;
          result.lastError = safeError(error);
        }
        if (traverseChildren && taskCountForRun(this.db, connectionId, runId) < MAX_TASKS) {
          addTask(
            this.db,
            connectionId,
            runId,
            "embedded",
            summary.uuid,
            { parentUuid: summary.uuid, depth: 1 },
            now,
          );
        } else if (traverseChildren) {
          result.truncated = true;
        }
      }
      if (page.nextCursor) result.nextCursor = page.nextCursor;
      return result;
    }
    if (task.task_kind === "embedded") {
      const page = await this.#request(
        connectionId,
        "documents.embedded.list",
        {
          connectionId,
          parentUuid: String(params["parentUuid"]),
          recursive: false,
          maxDepth: 1,
          pageSize,
          ...(task.cursor ? { cursor: task.cursor } : {}),
        },
        (value) => EmbeddedDocumentsListOutput.parse(value),
        signal,
      );
      result.truncated = page.truncated;
      for (const summary of page.items) {
        throwIfAborted(signal);
        result.scanned += 1;
        let traverseChildren = false;
        try {
          const stored = await this.#document(connectionId, runId, summary.uuid, now, signal);
          if (stored.changed) result.changed += 1;
          if (stored.privateFiltered) result.privateFiltered += 1;
          if (stored.truncated) result.truncated = true;
          traverseChildren = !stored.privateFiltered;
        } catch (error) {
          if (signal?.aborted) throw error;
          result.truncated = true;
          result.lastError = safeError(error);
        }
        const depth = Number(params["depth"] ?? 1);
        if (
          traverseChildren &&
          depth < 8 &&
          taskCountForRun(this.db, connectionId, runId) < MAX_TASKS
        ) {
          addTask(
            this.db,
            connectionId,
            runId,
            "embedded",
            summary.uuid,
            { parentUuid: summary.uuid, depth: depth + 1 },
            now,
          );
        } else if (traverseChildren && depth >= 8) {
          result.truncated = true;
        }
      }
      if (page.nextCursor) result.nextCursor = page.nextCursor;
      return result;
    }

    const page = await this.#request(
      connectionId,
      "compendiums.documents.list",
      {
        connectionId,
        packId: String(params["packId"]),
        hydrate: true,
        pageSize,
        sort: { field: "id", direction: "asc" },
        ...(task.cursor ? { cursor: task.cursor } : {}),
      },
      (value) => CompendiumDocumentsListOutput.parse(value),
      signal,
    );
    for (const item of page.items) {
      throwIfAborted(signal);
      result.scanned += 1;
      const parsed = DocumentsGetOutput.safeParse(item);
      if (!parsed.success) {
        result.truncated = true;
        continue;
      }
      const stored = upsertSnapshot(
        this.db,
        connectionId,
        runId,
        parsed.data,
        this.options.capturePrivateContent === true,
        now,
      );
      if (stored.changed) result.changed += 1;
      if (stored.privateFiltered) result.privateFiltered += 1;
      if (stored.truncated) result.truncated = true;
      if (!stored.privateFiltered && taskCountForRun(this.db, connectionId, runId) < MAX_TASKS) {
        addTask(
          this.db,
          connectionId,
          runId,
          "embedded",
          parsed.data.uuid,
          { parentUuid: parsed.data.uuid, depth: 1 },
          now,
        );
      } else if (!stored.privateFiltered) {
        result.truncated = true;
      }
    }
    if (page.nextCursor) result.nextCursor = page.nextCursor;
    return result;
  }

  async #reconcile(
    connectionId: string,
    reason: ReconcileReason,
    signal?: AbortSignal,
  ): Promise<IntelligenceStatusOutput> {
    let job: JobRow | undefined;
    try {
      throwIfAborted(signal);
      job = await this.#resumeOrStart(connectionId, reason, signal);
      let remaining = this.#documentBudget;
      while (remaining > 0) {
        throwIfAborted(signal);
        const task = nextTask(this.db, connectionId, job.run_id);
        if (!task) break;
        const now = this.#now().toISOString();
        this.db
          .prepare(
            `UPDATE reconciliation_tasks SET status = 'running', updated_at = ?
           WHERE connection_id = ? AND run_id = ? AND task_key = ?`,
          )
          .run(now, connectionId, job.run_id, task.task_key);
        const page = await this.#processTask(connectionId, job.run_id, task, remaining, signal);
        remaining -= page.scanned;
        const taskStatus = page.nextCursor ? "pending" : "complete";
        this.db
          .prepare(
            `UPDATE reconciliation_tasks SET status = ?, cursor = ?, updated_at = ?
           WHERE connection_id = ? AND run_id = ? AND task_key = ?`,
          )
          .run(
            taskStatus,
            page.nextCursor ?? null,
            this.#now().toISOString(),
            connectionId,
            job.run_id,
            task.task_key,
          );
        this.db
          .prepare(
            `UPDATE reconciliation_jobs SET
             scanned_count = scanned_count + ?,
             changed_count = changed_count + ?,
             private_filtered_count = private_filtered_count + ?,
             truncated = CASE WHEN ? THEN 1 ELSE truncated END,
             gap = CASE WHEN ? THEN 1 ELSE gap END,
             last_error = COALESCE(?, last_error),
             updated_at = ?
           WHERE connection_id = ?`,
          )
          .run(
            page.scanned,
            page.changed,
            page.privateFiltered,
            page.truncated ? 1 : 0,
            page.truncated ? 1 : 0,
            page.lastError ?? null,
            this.#now().toISOString(),
            connectionId,
          );
        if (page.scanned === 0 && page.nextCursor) {
          throw new Error("reconciliation cursor advanced without returning a page");
        }
      }

      const depth = queueDepth(this.db, connectionId, job.run_id);
      const now = this.#now().toISOString();
      if (depth > 0) {
        this.db
          .prepare(
            `UPDATE reconciliation_jobs SET
             status = 'incomplete', queue_depth = ?, updated_at = ?
           WHERE connection_id = ?`,
          )
          .run(depth, now, connectionId);
      } else {
        const completedRunId = job.run_id;
        const completedRun = this.db
          .prepare(
            `SELECT gap, truncated FROM reconciliation_jobs
             WHERE connection_id = ? AND run_id = ?`,
          )
          .get(connectionId, completedRunId) as { gap: number; truncated: number } | undefined;
        this.db.transaction(() => {
          // A partial traversal cannot prove that an unseen object was deleted. Preserve stale
          // snapshots until a later gap-free pass can authoritatively remove them.
          if (completedRun?.gap === 0 && completedRun.truncated === 0) {
            this.db
              .prepare(
                `DELETE FROM intelligence_objects
               WHERE connection_id = ? AND last_seen_run_id <> ?`,
              )
              .run(connectionId, completedRunId);
          }
          this.db
            .prepare(
              `UPDATE reconciliation_jobs SET
               status = 'complete', queue_depth = 0, updated_at = ?, last_completed_at = ?
             WHERE connection_id = ?`,
            )
            .run(now, now, connectionId);
          this.db
            .prepare("DELETE FROM reconciliation_tasks WHERE connection_id = ? AND run_id = ?")
            .run(connectionId, completedRunId);
        })();
      }
    } catch (error) {
      const now = this.#now().toISOString();
      const runId = job?.run_id ?? crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO reconciliation_jobs
          (connection_id, run_id, status, reason, started_at, updated_at,
           scanned_count, changed_count, private_filtered_count, queue_depth, gap, truncated,
           last_error)
         VALUES (?, ?, 'failed', ?, ?, ?, 0, 0, 0, 0, 1, 1, ?)
         ON CONFLICT(connection_id) DO UPDATE SET
           status = 'failed', updated_at = excluded.updated_at, gap = 1, truncated = 1,
           last_error = excluded.last_error`,
        )
        .run(connectionId, runId, reason, now, now, safeError(error));
    }
    return getIntelligenceStatus(this.db, connectionId);
  }
}

function taskCountForRun(db: Database.Database, connectionId: string, runId: string): number {
  return (
    db
      .prepare(
        `SELECT count(*) AS count FROM reconciliation_tasks
         WHERE connection_id = ? AND run_id = ?`,
      )
      .get(connectionId, runId) as { count: number }
  ).count;
}

export function recordRetentionRun(
  db: Database.Database,
  lastRunAt: string,
  removedEvents: number,
): void {
  db.prepare(
    `INSERT INTO intelligence_retention_state (singleton, last_run_at, removed_events)
     VALUES (1, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET
       last_run_at = excluded.last_run_at,
       removed_events = excluded.removed_events`,
  ).run(lastRunAt, removedEvents);
}
