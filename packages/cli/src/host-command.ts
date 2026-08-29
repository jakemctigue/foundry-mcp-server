import fs from "node:fs";
import path from "node:path";
import {
  resolveAppDataDir,
  resolveConfig,
  startDaemon,
  type ConfigFileSource,
  type Daemon,
  type EnvSource,
  type HostConfig,
  type StartDaemonOptions,
} from "@foundry-mcp/host";
import type { HostCommandOptions } from "./command-line.js";

const LOG_LEVELS = new Set<HostConfig["logLevel"]>(["debug", "info", "warn", "error"]);
const PIPE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const BOOLEAN_ENV_VALUES = new Set(["1", "0", "true", "false", "yes", "no", "on", "off"]);

export interface ResolvedHostLaunch {
  appDataDir: string;
  config: HostConfig;
  configPath?: string;
}

interface SignalSource {
  once: (event: "SIGINT" | "SIGTERM", listener: () => void) => unknown;
  removeListener: (event: "SIGINT" | "SIGTERM", listener: () => void) => unknown;
}

export interface HostCommandDependencies {
  env?: EnvSource;
  start?: (options: StartDaemonOptions) => Promise<Daemon>;
  signalSource?: SignalSource;
  writeStderr?: (line: string) => void;
}

function invalid(label: string, expectation: string): never {
  throw new Error(`${label} ${expectation}`);
}

function validatePort(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 65_535) {
    invalid(label, "must be an integer from 0 through 65535");
  }
  return Number(value);
}

function validatePipeName(value: unknown, label: string): string {
  if (typeof value !== "string" || !PIPE_NAME_PATTERN.test(value)) {
    invalid(label, "must be 1-64 letters, digits, dots, underscores, or hyphens");
  }
  return value;
}

function validateLogLevel(value: unknown, label: string): HostConfig["logLevel"] {
  if (typeof value !== "string" || !LOG_LEVELS.has(value as HostConfig["logLevel"])) {
    invalid(label, "must be debug, info, warn, or error");
  }
  return value as HostConfig["logLevel"];
}

function validateDbPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    invalid(label, "must be a non-empty filesystem path");
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) return true;
  }
  return false;
}

function validateEventCategories(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (item) =>
        typeof item === "string" &&
        item.length > 0 &&
        item.length <= 128 &&
        !hasControlCharacter(item),
    )
  ) {
    invalid(label, "must be a non-empty array of non-empty event category strings");
  }
  return [...new Set(value as string[])];
}

function validateRetentionDays(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 36_500) {
    invalid(label, "must be an integer from 1 through 36500");
  }
  return Number(value);
}

function normalizeOrigin(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.includes("*")) {
    invalid(label, "must be an exact http(s) Origin without whitespace or wildcards");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid(label, "must be a valid exact http(s) Origin");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.origin === "null"
  ) {
    invalid(label, "must contain only an http(s) scheme, host, and optional port");
  }
  return url.origin;
}

function validateAllowedOrigins(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    invalid(label, "must contain at least one exact Origin");
  }
  return [
    ...new Set(
      value.map((origin, index) => normalizeOrigin(origin, `${label}[${index.toString()}]`)),
    ),
  ];
}

function validateLocalAssetRoots(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) invalid(label, "must be an array of absolute filesystem paths");
  const normalized = value.map((root, index) => {
    if (
      typeof root !== "string" ||
      root.length === 0 ||
      root.trim() !== root ||
      root.includes("\0") ||
      !path.isAbsolute(root)
    ) {
      invalid(`${label}[${index.toString()}]`, "must be an absolute filesystem path");
    }
    return path.resolve(root);
  });
  return [...new Set(normalized)];
}

function splitLocalAssetRoots(value: string): string[] {
  const separator = value.includes(";") ? ";" : ",";
  return value
    .split(separator)
    .map((root) => root.trim())
    .filter(Boolean);
}

function validateHostConfigSource(
  source: Record<string, unknown>,
  label: string,
): ConfigFileSource {
  const validated: ConfigFileSource = {};
  if (Object.hasOwn(source, "port")) validated.port = validatePort(source["port"], `${label}.port`);
  if (Object.hasOwn(source, "pipeName")) {
    validated.pipeName = validatePipeName(source["pipeName"], `${label}.pipeName`);
  }
  if (Object.hasOwn(source, "logLevel")) {
    validated.logLevel = validateLogLevel(source["logLevel"], `${label}.logLevel`);
  }
  if (Object.hasOwn(source, "dbPath")) {
    validated.dbPath = validateDbPath(source["dbPath"], `${label}.dbPath`);
  }
  if (Object.hasOwn(source, "eventCategories")) {
    validated.eventCategories = validateEventCategories(
      source["eventCategories"],
      `${label}.eventCategories`,
    );
  }
  if (Object.hasOwn(source, "capturePrivateContent")) {
    if (typeof source["capturePrivateContent"] !== "boolean") {
      invalid(`${label}.capturePrivateContent`, "must be a boolean");
    }
    validated.capturePrivateContent = source["capturePrivateContent"] as boolean;
  }
  if (Object.hasOwn(source, "eventRetentionDays")) {
    validated.eventRetentionDays = validateRetentionDays(
      source["eventRetentionDays"],
      `${label}.eventRetentionDays`,
    );
  }
  if (Object.hasOwn(source, "allowedOrigins")) {
    validated.allowedOrigins = validateAllowedOrigins(
      source["allowedOrigins"],
      `${label}.allowedOrigins`,
    );
  }
  if (Object.hasOwn(source, "localAssetRoots")) {
    validated.localAssetRoots = validateLocalAssetRoots(
      source["localAssetRoots"],
      `${label}.localAssetRoots`,
    );
  }
  return validated;
}

function validateEnvironment(env: EnvSource): void {
  const numeric = [
    ["FOUNDRY_MCP_PORT", 0, 65_535],
    ["FOUNDRY_MCP_EVENT_RETENTION_DAYS", 1, 36_500],
  ] as const;
  for (const [key, minimum, maximum] of numeric) {
    const raw = env[key];
    if (raw === undefined) continue;
    if (!/^\d+$/u.test(raw) || Number(raw) < minimum || Number(raw) > maximum) {
      invalid(key, `must be an integer from ${minimum.toString()} through ${maximum.toString()}`);
    }
  }
  const capturePrivate = env["FOUNDRY_MCP_CAPTURE_PRIVATE_CONTENT"];
  if (
    capturePrivate !== undefined &&
    !BOOLEAN_ENV_VALUES.has(capturePrivate.trim().toLowerCase())
  ) {
    invalid("FOUNDRY_MCP_CAPTURE_PRIVATE_CONTENT", "must be a boolean value");
  }
  if (env["FOUNDRY_MCP_PIPE_NAME"] !== undefined) {
    validatePipeName(env["FOUNDRY_MCP_PIPE_NAME"], "FOUNDRY_MCP_PIPE_NAME");
  }
  if (env["FOUNDRY_MCP_LOG_LEVEL"] !== undefined) {
    validateLogLevel(env["FOUNDRY_MCP_LOG_LEVEL"], "FOUNDRY_MCP_LOG_LEVEL");
  }
  if (env["FOUNDRY_MCP_DB_PATH"] !== undefined) {
    validateDbPath(env["FOUNDRY_MCP_DB_PATH"], "FOUNDRY_MCP_DB_PATH");
  }
  const categories = env["FOUNDRY_MCP_EVENT_CATEGORIES"];
  if (categories !== undefined) {
    validateEventCategories(
      categories
        .split(",")
        .map((category) => category.trim())
        .filter(Boolean),
      "FOUNDRY_MCP_EVENT_CATEGORIES",
    );
  }
  const origins = env["FOUNDRY_MCP_ALLOWED_ORIGINS"];
  if (origins !== undefined) {
    validateAllowedOrigins(
      origins
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
      "FOUNDRY_MCP_ALLOWED_ORIGINS",
    );
  }
  const localAssetRoots = env["FOUNDRY_MCP_LOCAL_ASSET_ROOTS"];
  if (localAssetRoots !== undefined) {
    validateLocalAssetRoots(splitLocalAssetRoots(localAssetRoots), "FOUNDRY_MCP_LOCAL_ASSET_ROOTS");
  }
}

function validateResolvedConfig(config: HostConfig): HostConfig {
  return {
    port: validatePort(config.port, "resolved host config.port"),
    pipeName: validatePipeName(config.pipeName, "resolved host config.pipeName"),
    logLevel: validateLogLevel(config.logLevel, "resolved host config.logLevel"),
    dbPath: validateDbPath(config.dbPath, "resolved host config.dbPath"),
    eventCategories: validateEventCategories(
      config.eventCategories,
      "resolved host config.eventCategories",
    ),
    capturePrivateContent:
      typeof config.capturePrivateContent === "boolean"
        ? config.capturePrivateContent
        : invalid("resolved host config.capturePrivateContent", "must be a boolean"),
    eventRetentionDays: validateRetentionDays(
      config.eventRetentionDays,
      "resolved host config.eventRetentionDays",
    ),
    allowedOrigins: validateAllowedOrigins(
      config.allowedOrigins,
      "resolved host config.allowedOrigins",
    ),
    localAssetRoots: validateLocalAssetRoots(
      config.localAssetRoots,
      "resolved host config.localAssetRoots",
    ),
  };
}

function resolveFilesystemPath(value: string, label: string): string {
  if (value.trim().length === 0 || value.includes("\0")) {
    invalid(label, "must be a non-empty filesystem path");
  }
  return path.resolve(value);
}

function loadConfigFile(configPath: string, required: boolean): ConfigFileSource {
  if (!fs.existsSync(configPath)) {
    if (required) throw new Error(`host config file does not exist: ${configPath}`);
    return {};
  }
  const stat = fs.statSync(configPath);
  if (!stat.isFile()) throw new Error(`host config path is not a file: ${configPath}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    throw new Error(`host config file is not valid JSON: ${configPath}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`host config root must be an object: ${configPath}`);
  }
  return validateHostConfigSource(parsed as Record<string, unknown>, "host config file");
}

function cliConfigSource(options: HostCommandOptions): Partial<HostConfig> {
  const source: Partial<HostConfig> = {};
  if (options.port !== undefined) {
    if (!/^\d+$/u.test(options.port)) invalid("--port", "must be a decimal integer");
    source.port = validatePort(Number(options.port), "--port");
  }
  if (options.pipeName !== undefined)
    source.pipeName = validatePipeName(options.pipeName, "--pipe-name");
  if (options.logLevel !== undefined)
    source.logLevel = validateLogLevel(options.logLevel, "--log-level");
  if (options.allowedOrigins.length > 0) {
    source.allowedOrigins = validateAllowedOrigins(options.allowedOrigins, "--allow-origin");
  }
  if ((options.localAssetRoots?.length ?? 0) > 0) {
    source.localAssetRoots = validateLocalAssetRoots(
      options.localAssetRoots,
      "--allow-local-asset-root",
    );
  }
  return source;
}

export function resolveHostLaunch(
  options: HostCommandOptions,
  env: EnvSource = process.env,
): ResolvedHostLaunch {
  const appDataDir = options.appDataDir
    ? resolveFilesystemPath(options.appDataDir, "--app-data")
    : resolveAppDataDir();
  const explicitConfigPath = options.configPath
    ? resolveFilesystemPath(options.configPath, "--config")
    : undefined;
  const configPath = explicitConfigPath ?? path.join(appDataDir, "config.json");
  const fileSource = loadConfigFile(configPath, explicitConfigPath !== undefined);
  validateEnvironment(env);
  const config = validateResolvedConfig(resolveConfig(fileSource, env, cliConfigSource(options)));
  return {
    appDataDir,
    config,
    ...(fs.existsSync(configPath) ? { configPath } : {}),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runHostCommand(
  options: HostCommandOptions,
  dependencies: HostCommandDependencies = {},
): Promise<void> {
  const env = dependencies.env ?? process.env;
  const launch = resolveHostLaunch(options, env);
  const daemon = await (dependencies.start ?? startDaemon)({
    appDataDir: launch.appDataDir,
    cliConfig: launch.config,
  });
  const writeStderr = dependencies.writeStderr ?? ((line: string) => process.stderr.write(line));
  const signalSource = dependencies.signalSource ?? process;
  writeStderr(
    `${JSON.stringify({
      event: "host.ready",
      companionEndpoint: daemon.companionEndpoint,
      pipePath: daemon.pipePath,
    })}\n`,
  );

  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const cleanup = (): void => {
      signalSource.removeListener("SIGINT", onSignal);
      signalSource.removeListener("SIGTERM", onSignal);
    };
    const onSignal = (): void => {
      if (stopping) return;
      stopping = true;
      cleanup();
      void daemon.shutdown().then(resolve, (error: unknown) => {
        reject(new Error(`host shutdown failed: ${describeError(error)}`));
      });
    };
    signalSource.once("SIGINT", onSignal);
    signalSource.once("SIGTERM", onSignal);
  });
}
