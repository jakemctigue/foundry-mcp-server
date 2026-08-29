import { describe, expect, it } from "vitest";
import { ErrorEnvelope, ErrorCode, makeError } from "../src/error.js";

describe("ErrorEnvelope", () => {
  it("accepts a valid error envelope", () => {
    const result = ErrorEnvelope.safeParse({
      code: "NOT_FOUND",
      message: "no such document",
      retryable: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an object missing code", () => {
    const result = ErrorEnvelope.safeParse({
      message: "no such document",
      retryable: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an object with an unknown code", () => {
    const result = ErrorEnvelope.safeParse({
      code: "TOTALLY_MADE_UP",
      message: "x",
      retryable: false,
    });
    expect(result.success).toBe(false);
  });

  it("includes all required enum codes", () => {
    const required = [
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
    ];
    for (const code of required) {
      expect(ErrorCode.safeParse(code).success).toBe(true);
    }
  });

  it("makeError omits details when not provided", () => {
    const err = makeError("INVALID_DATA", "bad input");
    expect(err).toEqual({ code: "INVALID_DATA", message: "bad input", retryable: false });
  });

  it("makeError includes details when provided", () => {
    const err = makeError("CONFLICT", "version mismatch", true, { expected: 1, actual: 2 });
    expect(err.details).toEqual({ expected: 1, actual: 2 });
  });
});
