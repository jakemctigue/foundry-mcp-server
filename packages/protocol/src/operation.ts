import { z } from "zod";

import { JsonValueSchema } from "./document.js";

export const MAX_OPERATION_DURATION_MS = 5 * 60 * 1_000;
export const MAX_OPERATION_PROGRESS_UPDATES = 1_000;

export const OperationControlSchema = z
  .object({
    deadline: z.number().int().safe().positive(),
    correlationId: z.string().trim().min(1).max(128),
    progress: z.boolean().default(false),
  })
  .strict();
export type OperationControl = z.infer<typeof OperationControlSchema>;

export const OperationProgressSchema = z
  .object({
    stage: z.enum(["start", "progress", "complete"]),
    progress: z.number().int().min(0).max(MAX_OPERATION_PROGRESS_UPDATES),
    total: z.literal(MAX_OPERATION_PROGRESS_UPDATES),
    message: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
export type OperationProgress = z.infer<typeof OperationProgressSchema>;

export const BridgeRequestMessageSchema = z
  .object({
    type: z.literal("request").optional(),
    id: z.string().trim().min(1).max(128),
    method: z.string().trim().min(1).max(512),
    params: z.record(z.string(), z.unknown()).default({}),
    control: OperationControlSchema.optional(),
  })
  .strict();
export type BridgeRequestMessage = z.infer<typeof BridgeRequestMessageSchema>;

export const BridgeCancelMessageSchema = z
  .object({
    type: z.literal("request.cancel"),
    id: z.string().trim().min(1).max(128),
    correlationId: z.string().trim().min(1).max(128),
    reason: z.enum(["cancelled", "timeout"]),
  })
  .strict();
export type BridgeCancelMessage = z.infer<typeof BridgeCancelMessageSchema>;

export const BridgeProgressMessageSchema = z
  .object({
    type: z.literal("request.progress"),
    id: z.string().trim().min(1).max(128),
    progress: OperationProgressSchema,
  })
  .strict();
export type BridgeProgressMessage = z.infer<typeof BridgeProgressMessageSchema>;

export const BridgeResponseMessageSchema = z
  .object({
    type: z.literal("response").optional(),
    id: z.string().trim().min(1).max(128),
    result: z.unknown().optional(),
    error: JsonValueSchema.optional(),
  })
  .strict();
export type BridgeResponseMessage = z.infer<typeof BridgeResponseMessageSchema>;

export interface OperationExecutionOptions {
  signal?: AbortSignal;
  deadline?: number;
  correlationId?: string;
  reportProgress?: (progress: OperationProgress) => void | Promise<void>;
  markCommitted?: (details?: string) => void;
}

export function operationAbortCode(
  signal: AbortSignal | undefined,
  deadline: number | undefined,
  now = Date.now(),
): "CANCELLED" | "TIMEOUT" | undefined {
  if (deadline !== undefined && now >= deadline) return "TIMEOUT";
  return signal?.aborted ? "CANCELLED" : undefined;
}
