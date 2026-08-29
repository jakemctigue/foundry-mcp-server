import type Database from "better-sqlite3";

import type { Logger } from "../logger.js";
import { pruneEventsByRetentionDays } from "./event-ledger.js";
import {
  getIntelligenceStatus,
  IntelligenceReconciler,
  recordRetentionRun,
} from "./reconciliation.js";

const DEFAULT_RECONCILIATION_INTERVAL_MS = 5 * 60 * 1_000;
const DEFAULT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface IntelligenceCoordinatorOptions {
  retentionDays: number;
  logger?: Logger;
  now?: () => Date;
  reconciliationIntervalMs?: number;
  retentionIntervalMs?: number;
}

function positiveInterval(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 10) {
    throw new Error(`${label} must be an integer of at least 10 milliseconds`);
  }
  return result;
}

/** Schedules local reconciliation and retention without invoking any external AI provider. */
export class IntelligenceCoordinator {
  readonly #connected = new Set<string>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #now: () => Date;
  readonly #reconciliationIntervalMs: number;
  readonly #retentionIntervalMs: number;
  #abortController = new AbortController();
  #stopped = false;
  #reconciliationTimer: ReturnType<typeof setInterval> | undefined;
  #retentionTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly db: Database.Database,
    readonly reconciler: IntelligenceReconciler,
    readonly options: IntelligenceCoordinatorOptions,
  ) {
    if (!Number.isSafeInteger(options.retentionDays) || options.retentionDays < 0) {
      throw new Error("retentionDays must be a non-negative integer");
    }
    this.#now = options.now ?? (() => new Date());
    this.#reconciliationIntervalMs = positiveInterval(
      options.reconciliationIntervalMs,
      DEFAULT_RECONCILIATION_INTERVAL_MS,
      "reconciliationIntervalMs",
    );
    this.#retentionIntervalMs = positiveInterval(
      options.retentionIntervalMs,
      DEFAULT_RETENTION_INTERVAL_MS,
      "retentionIntervalMs",
    );
  }

  start(): void {
    if (this.#reconciliationTimer || this.#retentionTimer) return;
    if (this.#abortController.signal.aborted) this.#abortController = new AbortController();
    this.#stopped = false;
    this.runRetention();
    this.#reconciliationTimer = setInterval(
      () => this.runPeriodic(),
      this.#reconciliationIntervalMs,
    );
    this.#retentionTimer = setInterval(() => this.runRetention(), this.#retentionIntervalMs);
    this.#reconciliationTimer.unref?.();
    this.#retentionTimer.unref?.();
  }

  updateConnections(connectionIds: readonly string[]): void {
    if (this.#stopped) return;
    const next = new Set(connectionIds);
    for (const connectionId of next) {
      if (this.#connected.has(connectionId)) continue;
      const reason =
        getIntelligenceStatus(this.db, connectionId).status === "never" ? "initial" : "reconnect";
      this.#track(
        this.reconciler.reconcile(connectionId, reason, {
          signal: this.#abortController.signal,
        }),
      );
    }
    this.#connected.clear();
    for (const connectionId of next) this.#connected.add(connectionId);
  }

  runPeriodic(): void {
    if (this.#stopped) return;
    for (const connectionId of this.#connected) {
      this.#track(
        this.reconciler.reconcile(connectionId, "periodic", {
          signal: this.#abortController.signal,
        }),
      );
    }
  }

  runRetention(): number {
    const now = this.#now();
    const removed = pruneEventsByRetentionDays(this.db, this.options.retentionDays, now);
    recordRetentionRun(this.db, now.toISOString(), removed);
    this.options.logger?.info("intelligence event retention completed", {
      removedEvents: removed,
      retentionDays: this.options.retentionDays,
    });
    return removed;
  }

  async drain(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.allSettled([...this.#pending]);
    }
  }

  stop(): void {
    this.#stopped = true;
    if (this.#reconciliationTimer) clearInterval(this.#reconciliationTimer);
    if (this.#retentionTimer) clearInterval(this.#retentionTimer);
    this.#reconciliationTimer = undefined;
    this.#retentionTimer = undefined;
    this.#connected.clear();
    this.#abortController.abort(new Error("intelligence coordinator stopped"));
  }

  #track(operation: Promise<unknown>): void {
    this.#pending.add(operation);
    void operation
      .catch((error: unknown) => {
        this.options.logger?.error("intelligence reconciliation failed", {
          errorType: error instanceof Error ? error.name : "unknown",
        });
      })
      .finally(() => this.#pending.delete(operation));
  }
}
