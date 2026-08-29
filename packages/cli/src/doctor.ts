import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  MIGRATIONS,
  defaultUserIdentifier,
  openDatabase,
  resolveAppDataDir,
  resolvePipePath,
} from "@foundry-mcp/host";

export type CheckStatus = "OK" | "WARN" | "FAIL";

export interface CheckResult {
  id: string;
  status: CheckStatus;
  message: string;
  hint?: string;
}

export interface DoctorOptions {
  appDataDir?: string;
  configPath?: string;
  databasePath?: string;
  foundryUserDataPath?: string;
  dockerUserDataPath?: string;
  moduleId?: string;
  bridgeUrl?: string;
  foundryOrigin?: string;
  allowedOrigins?: readonly string[];
  providerEnv?: Record<string, string | undefined>;
  statusPath?: string;
  pipeProbe?: (pipePath: string) => Promise<boolean>;
}

interface LoadedConfig {
  result: CheckResult;
  value: Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value;
}

function loadConfig(options: DoctorOptions): LoadedConfig {
  const configPath = options.configPath;
  if (!configPath) {
    return {
      result: { id: "config", status: "OK", message: "no config file configured; using defaults" },
      value: {},
    };
  }
  if (!fs.existsSync(configPath)) {
    return {
      result: {
        id: "config",
        status: "WARN",
        message: `config file not found at ${configPath}`,
        hint: "create the config file, or omit --config to use defaults",
      },
      value: {},
    };
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config root must be an object");
    }
    return {
      result: { id: "config", status: "OK", message: `config file at ${configPath} is valid JSON` },
      value: parsed as Record<string, unknown>,
    };
  } catch {
    return {
      result: {
        id: "config",
        status: "FAIL",
        message: `config file at ${configPath} is not valid object-shaped JSON`,
        hint: `fix or remove the invalid JSON config file at ${configPath}`,
      },
      value: {},
    };
  }
}

function checkConfigPermissions(configPath: string | undefined): CheckResult {
  if (!configPath || !fs.existsSync(configPath)) {
    return {
      id: "config-permissions",
      status: "OK",
      message: "no config file permissions to inspect",
    };
  }

  try {
    fs.accessSync(configPath, fs.constants.R_OK | fs.constants.W_OK);
    if (process.platform === "win32") {
      const acl = spawnSync("icacls.exe", [configPath], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (acl.status !== 0) {
        return {
          id: "config-permissions",
          status: "WARN",
          message: "config is accessible, but its Windows ACL could not be verified",
          hint: "run icacls on the config and restrict access to the current user",
        };
      }
      if (/(?:Everyone|BUILTIN\\Users|Authenticated Users):/i.test(acl.stdout)) {
        return {
          id: "config-permissions",
          status: "WARN",
          message: "config Windows ACL includes a broad user principal",
          hint: "remove broad ACL entries and grant access only to the current user and SYSTEM",
        };
      }
      return {
        id: "config-permissions",
        status: "OK",
        message: "config Windows ACL does not expose a known broad user principal",
      };
    }
    const mode = fs.statSync(configPath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return {
        id: "config-permissions",
        status: "WARN",
        message: "config is accessible by group or other users",
        hint: `restrict the config with chmod 600 ${configPath}`,
      };
    }
    return {
      id: "config-permissions",
      status: "OK",
      message: "config is readable and writable by the current user",
    };
  } catch {
    return {
      id: "config-permissions",
      status: "FAIL",
      message: "config is not readable and writable by the current user",
      hint: "grant only the current user read/write access to the config file",
    };
  }
}

function checkDatabase(databasePath: string): CheckResult[] {
  if (!fs.existsSync(databasePath)) {
    return [
      {
        id: "database",
        status: "WARN",
        message: `database has not been created at ${databasePath}`,
        hint: "start the foundry-mcp host once to initialize its database",
      },
      {
        id: "migrations",
        status: "WARN",
        message: "database migrations cannot be checked before initialization",
        hint: "start the host, then rerun doctor",
      },
    ];
  }

  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(databasePath);
    db.prepare("SELECT 1").get();
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get() as { name?: string } | undefined;
    if (!table) {
      return [
        { id: "database", status: "OK", message: `database reachable at ${databasePath}` },
        {
          id: "migrations",
          status: "FAIL",
          message: "schema_migrations table is missing",
          hint: "stop the host, back up the database, and run the supported migration command",
        },
      ];
    }

    const applied = db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{
      id: number;
    }>;
    const appliedIds = new Set(applied.map(({ id }) => id));
    const missing = MIGRATIONS.map(({ id }) => id).filter((id) => !appliedIds.has(id));
    return [
      { id: "database", status: "OK", message: `database reachable at ${databasePath}` },
      missing.length === 0
        ? {
            id: "migrations",
            status: "OK",
            message: `all ${MIGRATIONS.length.toString()} database migration(s) are applied`,
          }
        : {
            id: "migrations",
            status: "FAIL",
            message: `${missing.length.toString()} database migration(s) are pending`,
            hint: "stop the host, back up the database, and run the supported migration command",
          },
    ];
  } catch {
    return [
      {
        id: "database",
        status: "FAIL",
        message: `could not open database at ${databasePath}`,
        hint: "check that the database directory is writable and the file is not locked",
      },
      {
        id: "migrations",
        status: "FAIL",
        message: "database migrations could not be inspected",
        hint: "resolve the database error, then rerun doctor",
      },
    ];
  } finally {
    db?.close();
  }
}

async function defaultPipeProbe(pipePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(pipePath);
    let settled = false;
    const finish = (connected: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(connected);
    };
    const timer = setTimeout(() => finish(false), 500);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function checkPipe(
  appDataDir: string,
  probe: (pipePath: string) => Promise<boolean>,
): Promise<{ result: CheckResult; connected: boolean }> {
  const pipePath = resolvePipePath(defaultUserIdentifier(), appDataDir);
  const connected = await probe(pipePath);
  return connected
    ? {
        connected,
        result: { id: "pipe", status: "OK", message: `bridge pipe reachable at ${pipePath}` },
      }
    : {
        connected,
        result: {
          id: "pipe",
          status: "WARN",
          message: `bridge pipe not reachable at ${pipePath}`,
          hint: "start the foundry-mcp host daemon before connecting an MCP client",
        },
      };
}

function checkActiveConnections(connected: boolean, statusPath: string): CheckResult {
  if (!connected) {
    return {
      id: "active-connections",
      status: "WARN",
      message: "active Foundry connections unavailable because the bridge is offline",
      hint: "start the host and an authorized Foundry client, then rerun doctor",
    };
  }
  if (!fs.existsSync(statusPath)) {
    return {
      id: "active-connections",
      status: "WARN",
      message: "bridge is online but no connection status snapshot is available",
      hint: "call foundry.connections.list to inspect live worlds",
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statusPath, "utf8")) as {
      activeConnections?: unknown;
    };
    if (!Number.isInteger(parsed.activeConnections) || Number(parsed.activeConnections) < 0) {
      throw new Error("invalid active connection count");
    }
    const count = Number(parsed.activeConnections);
    return count > 0
      ? {
          id: "active-connections",
          status: "OK",
          message: `${count.toString()} active Foundry connection(s) reported`,
        }
      : {
          id: "active-connections",
          status: "WARN",
          message: "host reports zero active Foundry connections",
          hint: "enable the companion module in a world and connect as an authorized user",
        };
  } catch {
    return {
      id: "active-connections",
      status: "FAIL",
      message: "connection status snapshot is malformed",
      hint: "restart the host to regenerate its status snapshot",
    };
  }
}

function checkDockerUserData(dockerUserDataPath: string | undefined): CheckResult {
  if (!dockerUserDataPath) {
    return {
      id: "docker-user-data",
      status: "OK",
      message: "no Docker bind-mounted Foundry User Data path configured",
    };
  }
  if (!path.isAbsolute(dockerUserDataPath)) {
    return {
      id: "docker-user-data",
      status: "FAIL",
      message: "Docker bind-mounted Foundry User Data path is not absolute",
      hint: "pass the host-side absolute bind-mounted User Data path; Docker need not be running",
    };
  }
  if (!fs.existsSync(dockerUserDataPath) || !fs.statSync(dockerUserDataPath).isDirectory()) {
    return {
      id: "docker-user-data",
      status: "FAIL",
      message: "Docker bind-mounted Foundry User Data directory does not exist",
      hint: "create or mount the host-side User Data directory, then rerun doctor",
    };
  }
  try {
    fs.accessSync(dockerUserDataPath, fs.constants.R_OK | fs.constants.W_OK);
    return {
      id: "docker-user-data",
      status: "OK",
      message: "explicit Docker bind-mounted User Data path is locally readable and writable",
    };
  } catch {
    return {
      id: "docker-user-data",
      status: "FAIL",
      message: "Docker bind-mounted User Data path is not writable by the current user",
      hint: "fix host-side bind-mount permissions; doctor does not invoke Docker",
    };
  }
}

function checkModule(foundryUserDataPath: string | undefined, moduleId: string): CheckResult {
  if (!foundryUserDataPath) {
    return {
      id: "foundry-module",
      status: "WARN",
      message: "Foundry User Data path is not configured",
      hint: "pass --foundry-data or --docker-data to check the companion module installation",
    };
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(moduleId)) {
    return {
      id: "foundry-module",
      status: "FAIL",
      message: "module id is invalid",
      hint: "use a simple module id without path separators",
    };
  }
  const manifestPath = path.join(foundryUserDataPath, "Data", "modules", moduleId, "module.json");
  if (!fs.existsSync(manifestPath)) {
    return {
      id: "foundry-module",
      status: "WARN",
      message: `companion module is not installed under ${path.dirname(manifestPath)}`,
      hint: "run scripts/windows/install.ps1 with the same Foundry User Data path",
    };
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { id?: unknown };
    if (manifest.id !== moduleId) throw new Error("module id mismatch");
    return {
      id: "foundry-module",
      status: "OK",
      message: `companion module ${moduleId} is installed`,
    };
  } catch {
    return {
      id: "foundry-module",
      status: "FAIL",
      message: "installed companion module manifest is invalid or has the wrong id",
      hint: "reinstall the module from a verified package",
    };
  }
}

interface ParsedEndpoint {
  protocol: string;
  origin: string;
}

function parseEndpoint(
  raw: string,
  protocols: readonly string[],
  allowPath: boolean,
): ParsedEndpoint | undefined {
  try {
    const url = new URL(raw);
    if (
      !protocols.includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (!allowPath && url.pathname !== "/")
    ) {
      return undefined;
    }
    return { protocol: url.protocol, origin: url.origin };
  } catch {
    return undefined;
  }
}

function checkEndpointSecurity(
  bridgeUrl: string | undefined,
  foundryOrigin: string | undefined,
  allowedOrigins: readonly string[] | undefined,
): CheckResult[] {
  if (!bridgeUrl && !foundryOrigin && !allowedOrigins) {
    return [
      {
        id: "bridge-endpoint",
        status: "WARN",
        message: "module bridge endpoint and Foundry origin are not configured",
        hint: "configure an explicit ws:// or wss:// bridge URL and strict Foundry origin allowlist",
      },
      {
        id: "origin-allowlist",
        status: "WARN",
        message: "no strict Foundry origin allowlist is configured",
        hint: "allow the exact Foundry http(s) origin; do not use wildcards",
      },
    ];
  }

  const bridge = bridgeUrl ? parseEndpoint(bridgeUrl, ["ws:", "wss:"], true) : undefined;
  const origin = foundryOrigin
    ? parseEndpoint(foundryOrigin, ["http:", "https:"], false)
    : undefined;
  const endpointResult: CheckResult = !bridge
    ? {
        id: "bridge-endpoint",
        status: "FAIL",
        message: "bridge URL is missing or is not a credential-free ws:// or wss:// URL",
        hint: "configure a ws:// URL for HTTP Foundry or wss:// for HTTPS Foundry",
      }
    : !origin
      ? {
          id: "bridge-endpoint",
          status: "FAIL",
          message: "Foundry origin is missing or invalid",
          hint: "configure the exact http:// or https:// Foundry origin without a path",
        }
      : origin.protocol === "https:" && bridge.protocol !== "wss:"
        ? {
            id: "bridge-endpoint",
            status: "FAIL",
            message: "HTTPS Foundry cannot connect to an insecure ws:// bridge (mixed content)",
            hint: "serve the bridge through a trusted wss:// reverse proxy",
          }
        : {
            id: "bridge-endpoint",
            status: "OK",
            message: `${bridge.protocol === "wss:" ? "TLS" : "local plaintext"} WebSocket scheme is compatible with the Foundry origin`,
          };

  const normalizedAllowed = (allowedOrigins ?? [])
    .map((value) => parseEndpoint(value, ["http:", "https:"], false)?.origin)
    .filter((value): value is string => Boolean(value));
  const originResult: CheckResult = !origin
    ? {
        id: "origin-allowlist",
        status: "FAIL",
        message: "Foundry origin cannot be validated",
        hint: "configure the exact Foundry origin and allowlist",
      }
    : normalizedAllowed.length === 0
      ? {
          id: "origin-allowlist",
          status: "FAIL",
          message: "strict Foundry origin allowlist is empty",
          hint: "add the exact Foundry origin; wildcard origins are unsafe",
        }
      : normalizedAllowed.includes(origin.origin)
        ? {
            id: "origin-allowlist",
            status: "OK",
            message: "Foundry origin exactly matches the configured allowlist",
          }
        : {
            id: "origin-allowlist",
            status: "FAIL",
            message: "Foundry origin is not present in the strict allowlist",
            hint: "add the exact scheme, host, and port used by Foundry",
          };

  return [endpointResult, originResult];
}

function checkProvider(
  env: Record<string, string | undefined>,
  config: Record<string, unknown>,
): CheckResult {
  const keys = [
    "FOUNDRY_MCP_IMAGE_PROVIDER",
    "FOUNDRY_MCP_LLM_PROVIDER",
    "OPENAI_API_KEY",
    "COMFYUI_URL",
  ];
  const configuredInEnvironment = keys.some((key) => Boolean(env[key]?.trim()));
  const configuredInFile = ["provider", "imageProvider", "llmProvider", "providerApiKey"].some(
    (key) => {
      const value = config[key];
      return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
    },
  );
  const configured = configuredInEnvironment || configuredInFile;
  return configured
    ? {
        id: "provider",
        status: "OK",
        message: "external provider configuration is present (values redacted)",
      }
    : {
        id: "provider",
        status: "WARN",
        message: "no external image or intelligence provider is configured",
        hint: "configure a provider only when external processing is intentionally enabled",
      };
}

export async function runDoctor(options: DoctorOptions = {}): Promise<CheckResult[]> {
  const appDataDir = options.appDataDir ?? resolveAppDataDir();
  const loaded = loadConfig(options);
  const config = loaded.value;
  const configuredDatabasePath =
    options.databasePath ??
    stringValue(config["dbPath"]) ??
    path.join(appDataDir, "foundry-mcp.db");
  const databasePath = path.isAbsolute(configuredDatabasePath)
    ? configuredDatabasePath
    : path.join(appDataDir, configuredDatabasePath);
  const dockerUserDataPath =
    options.dockerUserDataPath ?? stringValue(config["dockerUserDataPath"]);
  const foundryUserDataPath =
    dockerUserDataPath ?? options.foundryUserDataPath ?? stringValue(config["foundryUserDataPath"]);
  const moduleId = options.moduleId ?? stringValue(config["moduleId"]) ?? "foundry-mcp";
  const bridgeUrl = options.bridgeUrl ?? stringValue(config["bridgeUrl"]);
  const foundryOrigin = options.foundryOrigin ?? stringValue(config["foundryOrigin"]);
  const allowedOrigins = options.allowedOrigins ?? stringArray(config["allowedOrigins"]);
  const statusPath = options.statusPath ?? path.join(appDataDir, "status.json");

  const results: CheckResult[] = [loaded.result, checkConfigPermissions(options.configPath)];
  results.push(...checkDatabase(path.resolve(databasePath)));
  const pipe = await checkPipe(appDataDir, options.pipeProbe ?? defaultPipeProbe);
  results.push(pipe.result, checkActiveConnections(pipe.connected, statusPath));
  results.push(checkDockerUserData(dockerUserDataPath));
  results.push(checkModule(foundryUserDataPath, moduleId));
  results.push(...checkEndpointSecurity(bridgeUrl, foundryOrigin, allowedOrigins));
  results.push(checkProvider(options.providerEnv ?? process.env, config));
  return results;
}

const STATUS_TAGS: Record<CheckStatus, string> = {
  OK: "[ OK ]",
  WARN: "[WARN]",
  FAIL: "[FAIL]",
};

function formatTag(status: CheckStatus): string {
  return STATUS_TAGS[status];
}

export function formatDoctorText(results: CheckResult[]): string {
  return results
    .map((result) => {
      const line = `${formatTag(result.status)} ${result.id}: ${result.message}`;
      return result.hint ? `${line}\n       -> ${result.hint}` : line;
    })
    .join("\n");
}

export function formatDoctorJson(results: CheckResult[]): string {
  return JSON.stringify(
    results.map((result) => ({
      name: result.id,
      status: result.status,
      message: result.message,
      hint: result.hint,
    })),
    null,
    2,
  );
}
