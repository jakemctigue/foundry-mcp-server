import type Database from "better-sqlite3";
import type {
  FoundryUserRole,
  MutationAuthorizationRequest,
  RequestedCapability,
} from "@foundry-mcp/protocol";

import { runAuthorizedOperation } from "./policy.js";

export interface MutationRequest {
  connectionId: string;
  requestedCapability: Exclude<RequestedCapability, "read">;
  tool: string;
  correlationId: string;
  auditDetails?: unknown;
}
export interface MutationAuthorizationRunner {
  run<T>(request: MutationRequest, operation: () => T | Promise<T>): Promise<T>;
}

export type FoundryRoleResolver = (
  connectionId: string,
) => FoundryUserRole | Promise<FoundryUserRole>;

/** Adapts trusted connection role metadata to the centralized policy/audit gate. */
export function createDatabaseMutationAuthorizer(
  db: Database.Database,
  resolveRole: FoundryRoleResolver,
): MutationAuthorizationRunner {
  return {
    async run<T>(request: MutationRequest, operation: () => T | Promise<T>): Promise<T> {
      const foundryUserRole = await resolveRole(request.connectionId);
      const policyRequest: MutationAuthorizationRequest = {
        connectionId: request.connectionId,
        foundryUserRole,
        requestedCapability: request.requestedCapability,
        tool: request.tool,
        correlationId: request.correlationId,
      };
      return runAuthorizedOperation(
        db,
        {
          ...policyRequest,
          ...(request.auditDetails === undefined ? {} : { auditDetails: request.auditDetails }),
        },
        operation,
      );
    },
  };
}
