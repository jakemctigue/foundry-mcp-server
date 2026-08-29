export interface HostConfig {
  port: number;
  pipeName: string;
  logLevel: "debug" | "info" | "warn" | "error";
  dbPath: string;
  eventCategories: string[];
  capturePrivateContent: boolean;
  eventRetentionDays: number;
}

export const DEFAULT_EVENT_CATEGORIES = [
  "document.create",
  "document.update",
  "document.delete",
  "journal",
  "scene",
  "combat",
  "chat.public",
] as const;

export const DEFAULT_CONFIG: HostConfig = {
  port: 0,
  pipeName: "foundry-mcp",
  logLevel: "info",
  dbPath: "foundry-mcp.db",
  eventCategories: [...DEFAULT_EVENT_CATEGORIES],
  capturePrivateContent: false,
  eventRetentionDays: 30,
};

export type ConfigFileSource = Partial<HostConfig>;
export type EnvSource = Record<string, string | undefined>;
export type CliSource = Partial<HostConfig>;

const ENV_KEY_MAP: Record<keyof HostConfig, string> = {
  port: "FOUNDRY_MCP_PORT",
  pipeName: "FOUNDRY_MCP_PIPE_NAME",
  logLevel: "FOUNDRY_MCP_LOG_LEVEL",
  dbPath: "FOUNDRY_MCP_DB_PATH",
  eventCategories: "FOUNDRY_MCP_EVENT_CATEGORIES",
  capturePrivateContent: "FOUNDRY_MCP_CAPTURE_PRIVATE_CONTENT",
  eventRetentionDays: "FOUNDRY_MCP_EVENT_RETENTION_DAYS",
};

function parseEnvValue(key: keyof HostConfig, raw: string): HostConfig[keyof HostConfig] {
  if (key === "port" || key === "eventRetentionDays") {
    return Number(raw);
  }
  if (key === "capturePrivateContent") {
    return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
  }
  if (key === "eventCategories") {
    return raw
      .split(",")
      .map((category) => category.trim())
      .filter((category) => category.length > 0);
  }
  return raw;
}

export function loadEnvSource(env: EnvSource): Partial<HostConfig> {
  const result: Partial<HostConfig> = {};
  for (const key of Object.keys(ENV_KEY_MAP) as Array<keyof HostConfig>) {
    const raw = env[ENV_KEY_MAP[key]];
    if (raw !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any)[key] = parseEnvValue(key, raw);
    }
  }
  return result;
}

/**
 * Merges configuration sources in precedence order: CLI flag > environment
 * variable > config file > built-in default. Later sources in this argument
 * list win over earlier ones; call sites pass them lowest-precedence-first.
 */
export function resolveConfig(
  fileSource: ConfigFileSource = {},
  envSource: EnvSource = {},
  cliSource: CliSource = {},
): HostConfig {
  const fromEnv = loadEnvSource(envSource);
  const resolved = {
    ...DEFAULT_CONFIG,
    ...fileSource,
    ...fromEnv,
    ...cliSource,
  };
  return {
    ...resolved,
    eventCategories: [...resolved.eventCategories],
  };
}
