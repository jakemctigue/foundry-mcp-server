import type { RequestedCapability } from "@foundry-mcp/protocol";

export interface MutationAuthorizationRequest {
  connectionId: string;
  requestedCapability: Exclude<RequestedCapability, "read">;
  tool: string;
  correlationId: string;
  auditDetails?: unknown;
}
export interface MutationAuthorizer {
  run<T>(
    request: MutationAuthorizationRequest,
    operation: () => T | Promise<T>,
  ): Promise<T>;
}

let correlationCounter = 0;

export function mutationContext(
  tool: string,
  args: Record<string, unknown>,
  requestedCapability: MutationAuthorizationRequest["requestedCapability"],
): MutationAuthorizationRequest | undefined {
  const connectionId = args["connectionId"];
  if (typeof connectionId !== "string" || connectionId.length === 0) return undefined;
  correlationCounter += 1;
  return {
    connectionId,
    requestedCapability,
    tool,
    correlationId: `mcp-${Date.now().toString(36)}-${correlationCounter.toString(36)}`,
    auditDetails: args,
  };
}
