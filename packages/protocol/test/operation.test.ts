import { describe, expect, it } from "vitest";

import {
  BridgeCancelMessageSchema,
  BridgeProgressMessageSchema,
  BridgeRequestMessageSchema,
  MAX_OPERATION_PROGRESS_UPDATES,
  OperationControlSchema,
  operationAbortCode,
} from "../src/index.js";

describe("operation control protocol", () => {
  it("bounds controls and validates correlated cancel/progress frames", () => {
    const control = OperationControlSchema.parse({
      deadline: Date.now() + 1_000,
      correlationId: "mcp-request-7",
      progress: true,
    });
    expect(
      BridgeRequestMessageSchema.parse({
        type: "request",
        id: "bridge-7",
        method: "documents.snapshot",
        params: {},
        control,
      }),
    ).toMatchObject({ id: "bridge-7", control });
    expect(
      BridgeCancelMessageSchema.parse({
        type: "request.cancel",
        id: "bridge-7",
        correlationId: "mcp-request-7",
        reason: "cancelled",
      }),
    ).toMatchObject({ reason: "cancelled" });
    expect(
      BridgeProgressMessageSchema.parse({
        type: "request.progress",
        id: "bridge-7",
        progress: {
          stage: "complete",
          progress: MAX_OPERATION_PROGRESS_UPDATES,
          total: MAX_OPERATION_PROGRESS_UPDATES,
        },
      }),
    ).toMatchObject({ progress: { stage: "complete" } });
    expect(
      OperationControlSchema.safeParse({
        deadline: Number.MAX_VALUE,
        correlationId: "x".repeat(129),
      }).success,
    ).toBe(false);
  });

  it("distinguishes caller cancellation from deadline expiry", () => {
    const controller = new AbortController();
    expect(operationAbortCode(controller.signal, Date.now() + 1_000)).toBeUndefined();
    controller.abort();
    expect(operationAbortCode(controller.signal, Date.now() + 1_000)).toBe("CANCELLED");
    expect(operationAbortCode(undefined, Date.now() - 1)).toBe("TIMEOUT");
  });
});
