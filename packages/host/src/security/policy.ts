import type Database from "better-sqlite3";
import { ErrorEnvelope } from "@foundry-mcp/protocol";
import { redactSecrets, redactSecretText } from "./redaction.js";

export const FOUNDRY_USER_ROLES = ["PLAYER", "TRUSTED", "ASSISTANT", "GAMEMASTER"] as const;
export type FoundryUserRole = (typeof FOUNDRY_USER_ROLES)[number];

export const REQUESTED_CAPABILITIES = [
  "read",
  "documents:create",
  "documents:update",
  "assets:upload",
  "assets:attach",
  "sessions:start",
  "sessions:append",
  "ai:network",
] as const;
export type RequestedCapability = (typeof REQUESTED_CAPABILITIES)[number];

const ROLE_CEILINGS: Record<FoundryUserRole, ReadonlySet<RequestedCapability>> = {
  PLAYER: new Set(["read"]),
  TRUSTED: new Set(["read"]),
  ASSISTANT: new Set(["read"]),
  GAMEMASTER: new Set(REQUESTED_CAPABILITIES),
};

export interface PolicyRequest {
  connectionId: string;
  foundryUserRole: FoundryUserRole;
  requestedCapability: RequestedCapability;
}

export type PolicyDecision =
  | { allowed: true; request: PolicyRequest; source: "read-default" | "explicit-grant" }
  | {
      allowed: false;
      request: PolicyRequest;
      reason: "unknown-role" | "unknown-capability" | "role-restricted" | "missing-grant";
      missingCapability: string;
    };

function isKnownRole(role: string): role is FoundryUserRole {
  return FOUNDRY_USER_ROLES.includes(role as FoundryUserRole);
}

function isKnownCapability(capability: string): capability is RequestedCapability {
  return REQUESTED_CAPABILITIES.includes(capability as RequestedCapability);
}

export function setCapabilityGrant(
  db: Database.Database,
  request: PolicyRequest,
  allowed: boolean,
  now: Date = new Date(),
): void {
  db.prepare(
    `INSERT INTO capability_grants
      (connection_id, foundry_user_role, capability, allowed, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(connection_id, foundry_user_role, capability) DO UPDATE SET
       allowed = excluded.allowed,
       updated_at = excluded.updated_at`,
  ).run(
    request.connectionId,
    request.foundryUserRole,
    request.requestedCapability,
    allowed ? 1 : 0,
    now.toISOString(),
  );
}

export function evaluatePolicy(db: Database.Database, request: PolicyRequest): PolicyDecision {
  const role = request.foundryUserRole as string;
  const capability = request.requestedCapability as string;
  if (!isKnownRole(role)) {
    return { allowed: false, request, reason: "unknown-role", missingCapability: capability };
  }
  if (!isKnownCapability(capability)) {
    return { allowed: false, request, reason: "unknown-capability", missingCapability: capability };
  }
  if (!ROLE_CEILINGS[role].has(capability)) {
    return { allowed: false, request, reason: "role-restricted", missingCapability: capability };
  }
  if (capability === "read") {
    return { allowed: true, request, source: "read-default" };
  }

  const row = db
    .prepare(
      `SELECT allowed FROM capability_grants
       WHERE connection_id = ? AND foundry_user_role = ? AND capability = ?`,
    )
    .get(request.connectionId, role, capability) as { allowed: number } | undefined;
  if (row?.allowed === 1) {
    return { allowed: true, request, source: "explicit-grant" };
  }
  return { allowed: false, request, reason: "missing-grant", missingCapability: capability };
}

export class PermissionDeniedError extends Error {
  readonly code = "PERMISSION_DENIED";
  readonly missingCapability: string;
  readonly connectionId: string;

  constructor(decision: Extract<PolicyDecision, { allowed: false }>) {
    super(`Permission denied: missing capability ${decision.missingCapability}`);
    this.name = "PermissionDeniedError";
    this.missingCapability = decision.missingCapability;
    this.connectionId = decision.request.connectionId;
  }

  toJSON(): {
    code: "PERMISSION_DENIED";
    message: string;
    missingCapability: string;
    connectionId: string;
  } {
    return {
      code: this.code,
      message: this.message,
      missingCapability: this.missingCapability,
      connectionId: this.connectionId,
    };
  }
}
export interface AuthorizedOperationOptions extends PolicyRequest {
  additionalCapabilities?: readonly RequestedCapability[];
  tool: string;
  correlationId: string;
  auditDetails?: unknown;
  now?: () => Date;
  onAuditFailure?: (error: Error, committed: boolean) => void;
}

function reportAuditFailure(
  options: AuthorizedOperationOptions,
  error: unknown,
  committed: boolean,
): void {
  options.onAuditFailure?.(error instanceof Error ? error : new Error(String(error)), committed);
}

function structuredOperationError(error: unknown): unknown | undefined {
  if (!error || typeof error !== "object") return undefined;
  const parsed = ErrorEnvelope.safeParse((error as { envelope?: unknown }).envelope);
  return parsed.success ? parsed.data : undefined;
}

function recordAudit(
  db: Database.Database,
  values: {
    timestamp: string;
    connectionId: string;
    tool: string;
    capability: string;
    outcome: "success" | "denied" | "error";
    correlationId: string;
    details: unknown;
  },
): void {
  db.prepare(
    `INSERT INTO audit_log
      (timestamp, connection_id, tool, capability, outcome, correlation_id, details_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    values.timestamp,
    values.connectionId,
    values.tool,
    values.capability,
    values.outcome,
    values.correlationId,
    JSON.stringify(redactSecrets(values.details)),
  );
}

/** Central mutation interception point: authorize once and audit exactly once. */
export async function runAuthorizedOperation<T>(
  db: Database.Database,
  options: AuthorizedOperationOptions,
  operation: () => T | Promise<T>,
): Promise<T> {
  const timestamp = (options.now?.() ?? new Date()).toISOString();
  const capabilities = [
    options.requestedCapability,
    ...(options.additionalCapabilities ?? []),
  ].filter((capability, index, values) => values.indexOf(capability) === index);
  let decisions: PolicyDecision[];
  try {
    decisions = capabilities.map((requestedCapability) =>
      evaluatePolicy(db, {
        connectionId: options.connectionId,
        foundryUserRole: options.foundryUserRole,
        requestedCapability,
      }),
    );
  } catch (error) {
    try {
      recordAudit(db, {
        timestamp,
        connectionId: options.connectionId,
        tool: options.tool,
        capability: options.requestedCapability,
        outcome: "error",
        correlationId: options.correlationId,
        details: {
          request: options.auditDetails,
          error: redactSecretText(error instanceof Error ? error.message : String(error)),
          ...(structuredOperationError(error)
            ? { operationOutcome: structuredOperationError(error) }
            : {}),
        },
      });
    } catch (auditError) {
      reportAuditFailure(options, auditError, false);
    }
    throw error;
  }

  const denied = decisions.find(
    (decision): decision is Extract<PolicyDecision, { allowed: false }> => !decision.allowed,
  );
  if (denied) {
    try {
      recordAudit(db, {
        timestamp,
        connectionId: options.connectionId,
        tool: options.tool,
        capability: options.requestedCapability,
        outcome: "denied",
        correlationId: options.correlationId,
        details: {
          request: options.auditDetails,
          reason: denied.reason,
          requiredCapabilities: capabilities,
        },
      });
    } catch (auditError) {
      reportAuditFailure(options, auditError, false);
    }
    throw new PermissionDeniedError(denied);
  }

  let result: T;
  try {
    result = await operation();
  } catch (error) {
    try {
      recordAudit(db, {
        timestamp,
        connectionId: options.connectionId,
        tool: options.tool,
        capability: options.requestedCapability,
        outcome: "error",
        correlationId: options.correlationId,
        details: {
          request: options.auditDetails,
          error: redactSecretText(error instanceof Error ? error.message : String(error)),
          ...(structuredOperationError(error)
            ? { operationOutcome: structuredOperationError(error) }
            : {}),
        },
      });
    } catch (auditError) {
      reportAuditFailure(options, auditError, false);
    }
    throw error;
  }

  try {
    recordAudit(db, {
      timestamp,
      connectionId: options.connectionId,
      tool: options.tool,
      capability: options.requestedCapability,
      outcome: "success",
      correlationId: options.correlationId,
      details: { request: options.auditDetails },
    });
  } catch (auditError) {
    // The external side effect has committed. Reporting this as operation
    // failure would invite unsafe retries; surface audit degradation out of
    // band and return the committed result exactly once.
    reportAuditFailure(options, auditError, true);
  }
  return result;
}
