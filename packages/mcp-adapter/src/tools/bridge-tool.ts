import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

import { ErrorEnvelope, makeError } from "@foundry-mcp/protocol";
import type { BridgeConnection } from "../bridge-connection.js";
import type {
  MutationAuthorizationRequest,
  MutationAuthorizer,
} from "../mutation-authorization.js";

function errorContent(error: z.infer<typeof ErrorEnvelope>): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return { content: [{ type: "text", text: JSON.stringify(error) }], isError: true };
}

export class BridgeResultError extends Error {
  constructor(readonly envelope: z.infer<typeof ErrorEnvelope>) {
    super(envelope.message);
  }
}

export async function requestBridgeValue<T>(
  bridge: BridgeConnection,
  method: string,
  args: Record<string, unknown>,
  outputSchema: z.ZodType<T>,
): Promise<T> {
  let raw = await bridge.request(method, args);
  if (raw && typeof raw === "object" && "ok" in raw) {
    const result = raw as { ok?: unknown; value?: unknown; error?: unknown };
    if (result.ok === false) {
      const parsedError = ErrorEnvelope.safeParse(result.error);
      throw new BridgeResultError(
        parsedError.success
          ? parsedError.data
          : makeError("FOUNDRY_ERROR", "Bridge returned a malformed operation error"),
      );
    }
    if (result.ok === true) raw = result.value;
  }
  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BridgeResultError(
      makeError("INVALID_DATA", `Bridge returned malformed data for ${method}`, false, {
        issues: parsed.error.issues,
      }),
    );
  }
  return parsed.data;
}

export async function forwardBridgeTool(
  bridge: BridgeConnection,
  method: string,
  args: Record<string, unknown>,
  outputSchema: z.ZodType,
): Promise<
  | { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> }
  | { content: Array<{ type: "text"; text: string }>; isError: true }
> {
  try {
    const parsed = await requestBridgeValue(bridge, method, args, outputSchema);
    return {
      content: [{ type: "text", text: `${method} completed successfully.` }],
      structuredContent: parsed as Record<string, unknown>,
    };
  } catch (error) {
    if (error instanceof BridgeResultError) return errorContent(error.envelope);
    return errorContent(makeError("OFFLINE_BRIDGE", `Bridge request ${method} failed`, true));
  }
}

class AuthorizedToolFailure extends Error {
  constructor(readonly result: Awaited<ReturnType<typeof forwardBridgeTool>>) {
    super("authorized bridge operation returned an error");
  }
}

function permissionError(
  error: unknown,
  request: MutationAuthorizationRequest,
): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const structured = error as {
    code?: unknown;
    missingCapability?: unknown;
    connectionId?: unknown;
    message?: unknown;
  };
  const missingCapability =
    typeof structured.missingCapability === "string"
      ? structured.missingCapability
      : request.requestedCapability;
  const connectionId =
    typeof structured.connectionId === "string" ? structured.connectionId : request.connectionId;
  return errorContent(
    makeError(
      "PERMISSION_DENIED",
      typeof structured.message === "string"
        ? structured.message
        : `Permission denied: missing capability ${missingCapability}`,
      false,
      { missingCapability, connectionId },
    ),
  );
}

export async function forwardAuthorizedBridgeTool(
  authorizer: MutationAuthorizer | undefined,
  authorization: MutationAuthorizationRequest | undefined,
  bridge: BridgeConnection,
  method: string,
  args: Record<string, unknown>,
  outputSchema: z.ZodType,
): Promise<Awaited<ReturnType<typeof forwardBridgeTool>>> {
  if (!authorization) {
    return errorContent(
      makeError(
        "PERMISSION_DENIED",
        "Mutating tools require an explicit connectionId for policy evaluation",
        false,
        { missingCapability: "connection:select" },
      ),
    );
  }
  if (!authorizer) {
    return forwardBridgeTool(
      bridge,
      "mutation.execute",
      { method, params: args, authorization },
      outputSchema,
    );
  }
  try {
    return await authorizer.run(authorization, async () => {
      const result = await forwardBridgeTool(bridge, method, args, outputSchema);
      if ("isError" in result && result.isError) throw new AuthorizedToolFailure(result);
      return result;
    });
  } catch (error) {
    if (error instanceof AuthorizedToolFailure) return error.result;
    return permissionError(error, authorization);
  }
}

export type ToolServer = Pick<McpServer, "registerTool">;
