import type Database from "better-sqlite3";
import { redactSecrets, redactSecretText } from "../security/redaction.js";
import { runAuthorizedOperation, type FoundryUserRole } from "../security/policy.js";
import type { StoredEvent } from "./event-ledger.js";
import { getEventsByIds } from "./queries.js";

export interface IntelligenceSummaryProvider {
  name: string;
  model: string;
  summarize(input: {
    connectionId: string;
    trust: "untrusted-foundry-content";
    events: readonly StoredEvent[];
    constraints: Readonly<{
      allowToolCalls: false;
      allowMutations: false;
      allowProviderRouting: false;
      allowCapabilityChanges: false;
      allowPolicyChanges: false;
    }>;
  }): Promise<unknown>;
}

export interface SummarizeEventsOptions {
  connectionId: string;
  eventIds: readonly number[];
  provider: IntelligenceSummaryProvider;
  foundryUserRole: FoundryUserRole;
  correlationId: string;
  now?: () => Date;
}

export type SummarizeEventsResult =
  | {
      status: "success";
      provenanceId: number;
      suggestion: unknown;
      suggestionTrust: "untrusted-provider-output";
      sourceEventIds: number[];
    }
  | {
      status: "failed";
      provenanceId: number;
      error: string;
      sourceEventIds: number[];
    };

function insertProvenance(
  db: Database.Database,
  values: {
    timestamp: string;
    connectionId: string;
    provider: string;
    model: string;
    sourceEventIds: readonly number[];
    status: "success" | "failed";
    suggestion?: unknown;
    errorMessage?: string;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO summary_provenance
        (timestamp, connection_id, provider, model, source_event_ids_json,
         status, suggestion_json, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      values.timestamp,
      values.connectionId,
      values.provider,
      values.model,
      JSON.stringify(values.sourceEventIds),
      values.status,
      values.suggestion === undefined ? null : JSON.stringify(values.suggestion),
      values.errorMessage ?? null,
    );
  return Number(result.lastInsertRowid);
}

/**
 * Calls an optional intelligence provider without allowing provider failure to
 * escape into event ingestion. The only persisted output is an auditable
 * suggestion/provenance record; this function has no Foundry mutation path.
 */
export async function summarizeEvents(
  db: Database.Database,
  options: SummarizeEventsOptions,
): Promise<SummarizeEventsResult> {
  const now = options.now?.() ?? new Date();
  const sourceEventIds = [...new Set(options.eventIds)];
  return runAuthorizedOperation(
    db,
    {
      connectionId: options.connectionId,
      foundryUserRole: options.foundryUserRole,
      requestedCapability: "ai:network",
      tool: "foundry.intelligence.summarize",
      correlationId: options.correlationId,
      auditDetails: {
        provider: options.provider.name,
        model: options.provider.model,
        sourceEventIds,
      },
      now: () => now,
    },
    async () => {
      const timestamp = now.toISOString();
      try {
        const events = Object.freeze(
          getEventsByIds(db, options.connectionId, sourceEventIds).map((event) =>
            Object.freeze({
              ...event,
              payload: redactSecrets(event.payload),
            }),
          ),
        );
        const constraints = Object.freeze({
          allowToolCalls: false as const,
          allowMutations: false as const,
          allowProviderRouting: false as const,
          allowCapabilityChanges: false as const,
          allowPolicyChanges: false as const,
        });
        const suggestion = redactSecrets(
          await options.provider.summarize({
            connectionId: options.connectionId,
            trust: "untrusted-foundry-content",
            events,
            constraints,
          }),
        );
        const provenanceId = insertProvenance(db, {
          timestamp,
          connectionId: options.connectionId,
          provider: options.provider.name,
          model: options.provider.model,
          sourceEventIds,
          status: "success",
          suggestion,
        });
        return {
          status: "success",
          provenanceId,
          suggestion,
          suggestionTrust: "untrusted-provider-output",
          sourceEventIds,
        };
      } catch (error) {
        const message = redactSecretText(error instanceof Error ? error.message : String(error));
        const provenanceId = insertProvenance(db, {
          timestamp,
          connectionId: options.connectionId,
          provider: options.provider.name,
          model: options.provider.model,
          sourceEventIds,
          status: "failed",
          errorMessage: message,
        });
        return { status: "failed", provenanceId, error: message, sourceEventIds };
      }
    },
  );
}
