import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor, formatDoctorText, formatDoctorJson } from "../src/doctor.js";

describe("doctor", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcp-doctor-"));
    dirs.push(dir);
    return dir;
  }

  it("reports OK for config, database, and pipe checks in a clean environment", async () => {
    const appDataDir = tmpDir();
    const results = await runDoctor({ appDataDir });
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId["config"]?.status).toBe("OK");
    expect(byId["database"]?.status).toBe("OK");
    expect(["OK", "WARN"]).toContain(byId["pipe"]?.status);
  });

  it("formats text output with fixed-width status tags", async () => {
    const appDataDir = tmpDir();
    const results = await runDoctor({ appDataDir });
    const text = formatDoctorText(results);
    expect(text).toMatch(/\[ OK \]|\[WARN\]|\[FAIL\]/);
  });

  it("formats valid, parseable JSON output with name/status/message fields", async () => {
    const appDataDir = tmpDir();
    const results = await runDoctor({ appDataDir });
    const json = formatDoctorJson(results);
    const parsed = JSON.parse(json) as Array<Record<string, unknown>>;
    expect(Array.isArray(parsed)).toBe(true);
    for (const item of parsed) {
      expect(typeof item["name"]).toBe("string");
      expect(typeof item["status"]).toBe("string");
      expect(typeof item["message"]).toBe("string");
    }
  });

  it("reports a FAIL with a remediation hint for a malformed config file, without throwing", async () => {
    const appDataDir = tmpDir();
    const configPath = path.join(appDataDir, "config.json");
    fs.writeFileSync(configPath, "{ this is not valid json");

    const results = await runDoctor({ appDataDir, configPath });
    const configResult = results.find((r) => r.id === "config");
    expect(configResult?.status).toBe("FAIL");
    expect(configResult?.hint).toBeTruthy();
  });
});
