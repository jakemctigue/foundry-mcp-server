import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

import {
  ErrorEnvelope,
  MAX_OPERATION_DURATION_MS,
  MAX_OPERATION_PROGRESS_UPDATES,
  makeError,
  type OperationProgress,
} from "@foundry-mcp/protocol";
import {
  BridgeRequestError,
  type BridgeConnection,
  type BridgeRequestOptions,
} from "../bridge-connection.js";
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

interface McpRequestContextShape {
  mcpReq?: {
    id?: string | number;
    signal?: AbortSignal;
    _meta?: { progressToken?: unknown; [key: string]: unknown };
    notify?: (notification: unknown) => Promise<void>;
  };
}

function boundedDeadline(meta: Record<string, unknown> | undefined): number {
  const now = Date.now();
  const maximum = now + MAX_OPERATION_DURATION_MS;
  const requested = meta?.["foundryMcp/deadline"];
  return typeof requested === "number" && Number.isSafeInteger(requested) && requested > 0
    ? Math.min(requested, maximum)
    : maximum;
}

async function reportProgressSafely(
  onProgress: BridgeRequestOptions["onProgress"],
  update: OperationProgress,
): Promise<void> {
  try {
    await onProgress?.(update);
  } catch {
    // Progress is advisory and must never change an operation's terminal result.
  }
}

/** Converts SDK v2 request context into private bridge operation controls. */
export function bridgeRequestOptions(
  context: unknown,
  correlationId?: string,
): BridgeRequestOptions {
  const request = (context as McpRequestContextShape | undefined)?.mcpReq;
  const meta = request?._meta;
  const token = meta?.progressToken;
  const progressToken =
    typeof token === "string" || (typeof token === "number" && Number.isFinite(token))
      ? token
      : undefined;
  let lastProgress = -1;
  let notifications = 0;
  const onProgress =
    progressToken !== undefined && request?.notify
      ? async (update: OperationProgress): Promise<void> => {
          if (notifications >= MAX_OPERATION_PROGRESS_UPDATES || update.progress < lastProgress)
            return;
          lastProgress = update.progress;
          notifications += 1;
          try {
            await request.notify?.({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: update.progress,
                total: update.total,
                ...(update.message ? { message: update.message } : {}),
              },
            });
          } catch {
            // A disconnected or non-conforming progress consumer cannot undo bridge work.
          }
        }
      : undefined;
  return {
    ...(request?.signal ? { signal: request.signal } : {}),
    deadline: boundedDeadline(meta),
    correlationId:
      correlationId ??
      `mcp-${String(request?.id ?? "request")}-${Date.now().toString(36)}`.slice(0, 128),
    ...(onProgress ? { onProgress } : {}),
  };
}

export async function requestBridgeValue<T>(
  bridge: BridgeConnection,
  method: string,
  args: Record<string, unknown>,
  outputSchema: z.ZodType<T>,
  options?: BridgeRequestOptions,
): Promise<T> {
  await reportProgressSafely(options?.onProgress, {
    stage: "start",
    progress: 0,
    total: MAX_OPERATION_PROGRESS_UPDATES,
    message: `${method} started`,
  });
  const bridgeOptions = options
    ? {
        ...options,
        ...(options.onProgress
          ? {
              onProgress: (progress: OperationProgress) =>
                progress.stage === "start" || progress.stage === "complete"
                  ? undefined
                  : reportProgressSafely(options.onProgress, progress),
            }
          : {}),
      }
    : undefined;
  let raw = bridgeOptions
    ? await bridge.request(method, args, bridgeOptions)
    : await bridge.request(method, args);
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
  await reportProgressSafely(options?.onProgress, {
    stage: "complete",
    progress: MAX_OPERATION_PROGRESS_UPDATES,
    total: MAX_OPERATION_PROGRESS_UPDATES,
    message: `${method} completed`,
  });
  return parsed.data;
}

export async function forwardBridgeTool(
  bridge: BridgeConnection,
  method: string,
  args: Record<string, unknown>,
  outputSchema: z.ZodType,
  options?: BridgeRequestOptions,
): Promise<
  | { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> }
  | { content: Array<{ type: "text"; text: string }>; isError: true }
> {
  try {
    const parsed = await requestBridgeValue(bridge, method, args, outputSchema, options);
    return {
      content: [{ type: "text", text: `${method} completed successfully.` }],
      structuredContent: parsed as Record<string, unknown>,
    };
  } catch (error) {
    if (error instanceof BridgeResultError) return errorContent(error.envelope);
    if (error instanceof BridgeRequestError) return errorContent(error.envelope);
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
  options?: BridgeRequestOptions,
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
      options,
    );
  }
  try {
    return await authorizer.run(authorization, async () => {
      const result = await forwardBridgeTool(bridge, method, args, outputSchema, options);
      if ("isError" in result && result.isError) throw new AuthorizedToolFailure(result);
      return result;
    });
  } catch (error) {
    if (error instanceof AuthorizedToolFailure) return error.result;
    return permissionError(error, authorization);
  }
}

export type ToolServer = Pick<McpServer, "registerTool">;
