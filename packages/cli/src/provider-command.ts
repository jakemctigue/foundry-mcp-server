import path from "node:path";
import {
  createLogger,
  createSecretStorage,
  loadOpenAiImagesApiKey,
  removeOpenAiImagesApiKey,
  resolveAppDataDir,
  saveOpenAiImagesApiKey,
  type SecretStorage,
} from "@foundry-mcp/host";
import type { ProviderCommandOptions } from "./command-line.js";

const MAX_PROVIDER_SECRET_BYTES = 16 * 1024;

export interface ProviderCommandResult {
  provider: "openai-images";
  action: "configure" | "remove" | "status";
  configured: boolean;
}

export interface ProviderCommandDependencies {
  createStorage?: (appDataDir: string) => SecretStorage;
  readSecret?: () => Promise<string>;
  writeStderr?: (line: string) => void;
}

async function readSecretFromStandardInput(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error("provider configure requires the API key on standard input, not a CLI flag");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    total += bytes.length;
    if (total > MAX_PROVIDER_SECRET_BYTES) {
      throw new Error("provider API key input exceeds the maximum length");
    }
    chunks.push(bytes);
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error("provider API key input must contain exactly one value");
  }
  return value;
}

function resolveProviderAppDataDir(value: string | undefined): string {
  if (value === undefined) return resolveAppDataDir();
  if (value.trim().length === 0 || value.includes("\0")) {
    throw new Error("--app-data must be a non-empty filesystem path");
  }
  return path.resolve(value);
}

export async function runProviderCommand(
  options: ProviderCommandOptions,
  dependencies: ProviderCommandDependencies = {},
): Promise<ProviderCommandResult> {
  const appDataDir = resolveProviderAppDataDir(options.appDataDir);
  const writeStderr = dependencies.writeStderr ?? ((line: string) => process.stderr.write(line));
  const storage =
    dependencies.createStorage?.(appDataDir) ??
    createSecretStorage({
      dir: path.join(appDataDir, "secrets"),
      logger: createLogger({ level: "warn", sinks: [{ write: writeStderr }] }),
      allowDevelopmentFallback:
        process.env["NODE_ENV"] === "development" || process.env["NODE_ENV"] === "test",
    });

  if (options.action === "configure") {
    const apiKey = await (dependencies.readSecret ?? readSecretFromStandardInput)();
    await saveOpenAiImagesApiKey(storage, apiKey);
    return { provider: "openai-images", action: options.action, configured: true };
  }
  if (options.action === "remove") {
    await removeOpenAiImagesApiKey(storage);
    return { provider: "openai-images", action: options.action, configured: false };
  }
  return {
    provider: "openai-images",
    action: options.action,
    configured: (await loadOpenAiImagesApiKey(storage)) !== undefined,
  };
}

export function formatProviderCommandText(result: ProviderCommandResult): string {
  if (result.action === "configure") return "OpenAI Images provider key configured.";
  if (result.action === "remove") return "OpenAI Images provider key removed.";
  return `OpenAI Images provider key: ${result.configured ? "configured" : "not configured"}`;
}
