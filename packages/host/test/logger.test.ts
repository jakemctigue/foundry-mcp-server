import { describe, expect, it, vi, afterEach } from "vitest";
import { createLogger } from "../src/logger.js";

describe("logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never writes to stdout", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const fileLines: string[] = [];
    const logger = createLogger({
      sinks: [{ write: (line) => fileLines.push(line) }],
    });

    logger.info("hello world", { foo: "bar" });
    logger.error("oh no");

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(fileLines.length).toBe(2);
  });

  it("includes level, message, and timestamp fields", () => {
    const fileLines: string[] = [];
    const logger = createLogger({ sinks: [{ write: (line) => fileLines.push(line) }] });
    logger.warn("careful");
    const record = JSON.parse(fileLines[0] ?? "{}") as Record<string, unknown>;
    expect(record["level"]).toBe("warn");
    expect(record["message"]).toBe("careful");
    expect(typeof record["timestamp"]).toBe("string");
  });

  it("filters messages below the configured level", () => {
    const fileLines: string[] = [];
    const logger = createLogger({
      level: "warn",
      sinks: [{ write: (line) => fileLines.push(line) }],
    });
    logger.debug("noisy");
    logger.info("still noisy");
    logger.warn("audible");
    expect(fileLines.length).toBe(1);
  });
});
