import { describe, expect, it } from "vitest";
import type { SecretStorage } from "@foundry-mcp/host";
import { formatProviderCommandText, runProviderCommand } from "../src/provider-command.js";

describe("OpenAI Images provider secret command", () => {
  it("configures, reports, and removes a secret without returning its value", async () => {
    const values = new Map<string, Buffer>();
    const storage: SecretStorage = {
      save: async (key, value) => {
        values.set(key, Buffer.from(value));
      },
      load: async (key) => values.get(key),
      remove: async (key) => {
        values.delete(key);
      },
    };
    const rawSecret = "sk-provider-value-that-must-never-render";
    const dependencies = {
      createStorage: () => storage,
      readSecret: async () => rawSecret,
      writeStderr: () => undefined,
    };
    const configured = await runProviderCommand(
      { action: "configure", appDataDir: "C:/ignored", json: false },
      dependencies,
    );
    expect(configured.configured).toBe(true);
    expect(JSON.stringify(configured)).not.toContain(rawSecret);
    expect(formatProviderCommandText(configured)).not.toContain(rawSecret);

    await expect(
      runProviderCommand({ action: "status", appDataDir: "C:/ignored", json: true }, dependencies),
    ).resolves.toMatchObject({ configured: true });
    await expect(
      runProviderCommand({ action: "remove", appDataDir: "C:/ignored", json: false }, dependencies),
    ).resolves.toMatchObject({ configured: false });
    await expect(
      runProviderCommand({ action: "status", appDataDir: "C:/ignored", json: false }, dependencies),
    ).resolves.toMatchObject({ configured: false });
  });

  it("rejects short provider input without echoing it", async () => {
    const shortSecret = "tiny";
    const storage: SecretStorage = {
      save: async () => undefined,
      load: async () => undefined,
      remove: async () => undefined,
    };
    await expect(
      runProviderCommand(
        { action: "configure", json: false },
        { createStorage: () => storage, readSecret: async () => shortSecret },
      ),
    ).rejects.toThrow("OpenAI Images API key is invalid");
  });
});
