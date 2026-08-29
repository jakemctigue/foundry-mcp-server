import { z } from "zod";

export const ErrorCode = z.enum([
  "OFFLINE_BRIDGE",
  "AMBIGUOUS_CONNECTION",
  "UNSUPPORTED_TYPE",
  "INVALID_DATA",
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "CONFLICT",
  "TIMEOUT",
  "CANCELLED",
  "FOUNDRY_ERROR",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorEnvelope = z.object({
  code: ErrorCode,
  message: z.string(),
  retryable: z.boolean(),
  details: z.unknown().optional(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

export function makeError(
  code: ErrorCode,
  message: string,
  retryable = false,
  details?: unknown,
): ErrorEnvelope {
  return details === undefined
    ? { code, message, retryable }
    : { code, message, retryable, details };
}
