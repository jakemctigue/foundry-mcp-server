import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  BRIDGE_PROTOCOL_VERSION,
  DEFAULT_CONFIG,
  MIGRATIONS,
  connectPipeClient,
  defaultUserIdentifier,
  openDatabase,
  resolveAppDataDir,
  resolveConfig,
  resolvePipePath,
  type ConfigFileSource,
  type HostConfig,
  type PipeClient,
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
  pipeProbe?: DoctorPipeProbe;
}

export interface DoctorPipeProbeResult {
  status: "authenticated" | "offline" | "rejected";
  protocolVersion?: string;
}

export type DoctorPipeProbe = (
  pipePath: string,
  appDataDir: string,
) => Promise<DoctorPipeProbeResult>;

interface PipeProbeDependencies {
  connect?: (pipePath: string, appDataDir: string) => Promise<PipeClient>;
  timeoutMs?: number;
}

const DEFAULT_PIPE_PROBE_TIMEOUT_MS = 2_000;

interface LoadedConfig {
  result: CheckResult;
  value: Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value;
}

function hostConfigFileSource(config: Record<string, unknown>): ConfigFileSource {
  const source: ConfigFileSource = {};
  const port = config["port"];
  const pipeName = stringValue(config["pipeName"]);
  const logLevel = config["logLevel"];
  const dbPath = stringValue(config["dbPath"]);
  const eventCategories = stringArrayValue(config["eventCategories"]);
  const capturePrivateContent = config["capturePrivateContent"];
  const eventRetentionDays = config["eventRetentionDays"];
  const allowedOrigins = stringArrayValue(config["allowedOrigins"]);
  if (typeof port === "number") source.port = port;
  if (pipeName) source.pipeName = pipeName;
  if (["debug", "info", "warn", "error"].includes(String(logLevel))) {
    source.logLevel = logLevel as HostConfig["logLevel"];
  }
  if (dbPath) source.dbPath = dbPath;
  if (eventCategories) source.eventCategories = eventCategories;
  if (typeof capturePrivateContent === "boolean") {
    source.capturePrivateContent = capturePrivateContent;
  }
  if (typeof eventRetentionDays === "number") source.eventRetentionDays = eventRetentionDays;
  if (allowedOrigins) source.allowedOrigins = allowedOrigins;
  return source;
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

function resolveWindowsAclInspectorPath(): string | undefined {
  const systemRoot = process.env["SystemRoot"];
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) return undefined;

  const normalizedRoot = path.win32.normalize(systemRoot);
  if (!/^[a-z]:\\$/i.test(path.win32.parse(normalizedRoot).root)) return undefined;

  const candidate = path.win32.join(
    normalizedRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const relativeCandidate = path.win32.relative(normalizedRoot, candidate);
  if (
    !path.win32.isAbsolute(candidate) ||
    path.win32.isAbsolute(relativeCandidate) ||
    relativeCandidate === ".." ||
    relativeCandidate.startsWith(`..${path.win32.sep}`)
  ) {
    return undefined;
  }

  try {
    if (!fs.statSync(candidate).isFile()) return undefined;
    const realRoot = fs.realpathSync.native(normalizedRoot);
    const realCandidate = fs.realpathSync.native(candidate);
    const relativeRealPath = path.win32.relative(realRoot, realCandidate);
    if (
      path.win32.isAbsolute(relativeRealPath) ||
      relativeRealPath === ".." ||
      relativeRealPath.startsWith(`..${path.win32.sep}`)
    ) {
      return undefined;
    }
    return realCandidate;
  } catch {
    return undefined;
  }
}

const BROAD_WINDOWS_TRUSTEES = new Set([
  "WD",
  "AU",
  "BU",
  "S-1-1-0",
  "S-1-5-11",
  "S-1-5-32-545",
]);

const WINDOWS_ALLOW_ACE_TYPES = new Set(["A", "OA", "XA", "ZA"]);

/** Detect broad allow ACEs from locale-independent SDDL trustee identifiers. */
export function sddlHasBroadAccess(sddl: string): boolean {
  for (const match of sddl.matchAll(/\(([^()]*)\)/g)) {
    const fields = (match[1] ?? "").split(";");
    const aceType = fields[0]?.toUpperCase();
    const rights = fields[2];
    const trustee = fields[5]?.toUpperCase();
    if (
      aceType &&
      WINDOWS_ALLOW_ACE_TYPES.has(aceType) &&
      rights &&
      trustee &&
      BROAD_WINDOWS_TRUSTEES.has(trustee)
    ) {
      return true;
    }
  }
  return false;
}

function inspectWindowsAclSddl(configPath: string): string | undefined {
  const inspectorPath = resolveWindowsAclInspectorPath();
  if (!inspectorPath) return undefined;
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$target = [Environment]::GetEnvironmentVariable('FOUNDRY_MCP_ACL_TARGET', 'Process')",
    "if ([string]::IsNullOrWhiteSpace($target)) { throw 'ACL target is unavailable' }",
    "$sections = [System.Security.AccessControl.AccessControlSections]::All",
    "$acl = New-Object System.Security.AccessControl.FileSecurity($target, $sections)",
    "[Console]::Out.Write($acl.GetSecurityDescriptorSddlForm($sections))",
  ].join("; ");
  const inspected = spawnSync(
    inspectorPath,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "utf8",
      env: { ...process.env, FOUNDRY_MCP_ACL_TARGET: configPath },
      maxBuffer: 64 * 1024,
      timeout: 5_000,
      windowsHide: true,
    },
  );
  if (inspected.error || inspected.status !== 0) return undefined;
  const sddl = inspected.stdout.trim();
  return sddl.includes("D:") ? sddl : undefined;
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
      const sddl = inspectWindowsAclSddl(configPath);
      if (!sddl) {
        return {
          id: "config-permissions",
          status: "FAIL",
          message: "trusted Windows ACL inspection tool is unavailable",
          hint: "verify that SystemRoot points to Windows and Windows PowerShell is present",
        };
      }
      if (sddlHasBroadAccess(sddl)) {
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
        message: "config Windows SDDL does not grant a known broad user SID",
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
    db = openDatabase(databasePath, { readonly: true, fileMustExist: true });
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
    const knownIds = new Set(MIGRATIONS.map(({ id }) => id));
    const missing = [...knownIds].filter((id) => !appliedIds.has(id));
    const unknown = [...appliedIds].filter((id) => !knownIds.has(id));
    const migrationIssues = [
      ...(missing.length > 0
        ? [`${missing.length.toString()} database migration(s) are pending`]
        : []),
      ...(unknown.length > 0
        ? [`${unknown.length.toString()} unknown or future database migration(s) are present`]
        : []),
    ];
    return [
      { id: "database", status: "OK", message: `database reachable at ${databasePath}` },
      migrationIssues.length === 0
        ? {
            id: "migrations",
            status: "OK",
            message: `all ${MIGRATIONS.length.toString()} database migration(s) are applied`,
          }
        : {
            id: "migrations",
            status: "FAIL",
            message: migrationIssues.join("; "),
            hint: "stop the host, back up the database, and run the supported migration command",
          },
    ];
  } catch {
    return [
      {
        id: "database",
        status: "FAIL",
        message: `could not open database at ${databasePath}`,
        hint: "check that the database file exists, is readable, and is not locked",
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs.toString()}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function initializePipe(client: PipeClient): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = "doctor-initialize";
    client.onMessage((message) => {
      if (!message || typeof message !== "object") return;
      const response = message as { id?: unknown; result?: unknown; error?: unknown };
      if (response.id !== id) return;
      if (response.error !== undefined) {
        reject(new Error("daemon rejected bridge protocol initialization"));
        return;
      }
      const result = response.result as { protocolVersion?: unknown } | undefined;
      if (!result || typeof result.protocolVersion !== "string") {
        reject(new Error("daemon returned a malformed bridge protocol version"));
        return;
      }
      resolve(result.protocolVersion);
    });
    client.onError(reject);
    client.onClose?.(() => reject(new Error("daemon bridge closed during initialization")));
    client.send({ id, method: "initialize", params: {} });
  });
}

function isOfflinePipeError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "EBUSY";
}

export async function probeDaemonPipe(
  pipePath: string,
  appDataDir: string,
  dependencies: PipeProbeDependencies = {},
): Promise<DoctorPipeProbeResult> {
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_PIPE_PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("doctor pipe probe timeout must be a positive integer");
  }
  const connect =
    dependencies.connect ??
    ((targetPipePath: string, targetAppDataDir: string) =>
      connectPipeClient(targetPipePath, { appDataDir: targetAppDataDir }));
  let client: PipeClient | undefined;
  const pendingClient = connect(pipePath, appDataDir);
  try {
    try {
      client = await withTimeout(pendingClient, timeoutMs, "daemon authentication");
    } catch (error) {
      void pendingClient
        .then(async (lateClient) => lateClient.close())
        .catch(() => undefined);
      throw error;
    }
    const protocolVersion = await withTimeout(
      initializePipe(client),
      timeoutMs,
      "daemon protocol negotiation",
    );
    return { status: "authenticated", protocolVersion };
  } catch (error) {
    return { status: isOfflinePipeError(error) ? "offline" : "rejected" };
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        // The diagnostic result already fails closed; cleanup cannot make it healthier.
      }
    }
  }
}

async function checkPipe(
  appDataDir: string,
  pipeName: string,
  probe: DoctorPipeProbe,
): Promise<{ result: CheckResult; connected: boolean }> {
  const userIdentifier = defaultUserIdentifier();
  const pipeIdentifier =
    pipeName === DEFAULT_CONFIG.pipeName ? userIdentifier : `${userIdentifier}:${pipeName}`;
  const pipePath = resolvePipePath(pipeIdentifier, appDataDir);
  const outcome = await probe(pipePath, appDataDir);
  if (
    outcome.status === "authenticated" &&
    outcome.protocolVersion === BRIDGE_PROTOCOL_VERSION
  ) {
    return {
      connected: true,
      result: {
        id: "pipe",
        status: "OK",
        message: `bridge pipe authenticated with protocol ${BRIDGE_PROTOCOL_VERSION} at ${pipePath}`,
      },
    };
  }
  if (outcome.status === "offline") {
    return {
      connected: false,
      result: {
        id: "pipe",
        status: "WARN",
        message: `bridge pipe is offline at ${pipePath}`,
        hint: "start the foundry-mcp host daemon before connecting an MCP client",
      },
    };
  }
  return {
    connected: false,
    result: {
      id: "pipe",
      status: "FAIL",
      message:
        outcome.status === "authenticated"
          ? `bridge protocol version mismatch at ${pipePath}`
          : `bridge authentication or protocol negotiation failed at ${pipePath}`,
      hint: "verify the current-user bridge secret and run matching host and CLI versions",
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
  hostname: string;
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
    return { protocol: url.protocol, origin: url.origin, hostname: url.hostname };
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (normalized.toLowerCase() === "localhost") return true;
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) return normalized.startsWith("127.");
  if (ipVersion === 6) {
    const lower = normalized.toLowerCase();
    return lower === "::1" || lower.startsWith("::ffff:127.");
  }
  return false;
}

function checkEndpointSecurity(
  bridgeUrl: string | undefined,
  foundryOrigin: string | undefined,
  allowedOrigins: readonly string[] | undefined,
  invalidConfiguredOrigin = false,
): CheckResult[] {
  if (!bridgeUrl && !foundryOrigin) {
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
    : bridge.protocol === "ws:" && !isLoopbackHostname(bridge.hostname)
      ? {
          id: "bridge-endpoint",
          status: "FAIL",
          message: "plaintext ws:// bridge URLs are restricted to loopback hosts",
          hint: "use wss:// for remote bridges, or bind ws:// only to localhost/loopback",
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

  const parsedAllowed = (allowedOrigins ?? []).map((value) => ({
    raw: value,
    parsed: value.includes("*")
      ? undefined
      : parseEndpoint(value, ["http:", "https:"], false),
  }));
  const invalidAllowed = invalidConfiguredOrigin || parsedAllowed.some(({ parsed }) => !parsed);
  const normalizedAllowed = parsedAllowed.flatMap(({ parsed }) =>
    parsed ? [parsed.origin] : [],
  );
  const originResult: CheckResult = !origin
    ? {
        id: "origin-allowlist",
        status: "FAIL",
        message: "Foundry origin cannot be validated",
        hint: "configure the exact Foundry origin and allowlist",
      }
    : invalidAllowed
      ? {
          id: "origin-allowlist",
          status: "FAIL",
          message: "origin allowlist contains an invalid or wildcard Origin",
          hint: "remove every wildcard or invalid entry and allow exact http(s) origins only",
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
  const env = options.providerEnv ?? process.env;
  const invalidConfiguredOrigin =
    config["allowedOrigins"] !== undefined &&
    stringArrayValue(config["allowedOrigins"]) === undefined;
  const cliHostConfig: Partial<HostConfig> = {
    ...(options.databasePath === undefined ? {} : { dbPath: options.databasePath }),
    ...(options.allowedOrigins === undefined
      ? {}
      : { allowedOrigins: [...options.allowedOrigins] }),
  };
  const hostConfig = resolveConfig(hostConfigFileSource(config), env, cliHostConfig);
  const databasePath = path.isAbsolute(hostConfig.dbPath)
    ? hostConfig.dbPath
    : path.join(appDataDir, hostConfig.dbPath);
  const dockerUserDataPath =
    options.dockerUserDataPath ?? stringValue(config["dockerUserDataPath"]);
  const foundryUserDataPath =
    dockerUserDataPath ?? options.foundryUserDataPath ?? stringValue(config["foundryUserDataPath"]);
  const moduleId = options.moduleId ?? stringValue(config["moduleId"]) ?? "foundry-mcp";
  const bridgeUrl = options.bridgeUrl ?? stringValue(config["bridgeUrl"]);
  const foundryOrigin = options.foundryOrigin ?? stringValue(config["foundryOrigin"]);
  const allowedOrigins = hostConfig.allowedOrigins;
  const statusPath = options.statusPath ?? path.join(appDataDir, "status.json");

  const results: CheckResult[] = [loaded.result, checkConfigPermissions(options.configPath)];
  results.push(...checkDatabase(path.resolve(databasePath)));
  const pipe = await checkPipe(
    appDataDir,
    hostConfig.pipeName,
    options.pipeProbe ?? probeDaemonPipe,
  );
  results.push(pipe.result, checkActiveConnections(pipe.connected, statusPath));
  results.push(checkDockerUserData(dockerUserDataPath));
  results.push(checkModule(foundryUserDataPath, moduleId));
  results.push(
    ...checkEndpointSecurity(
      bridgeUrl,
      foundryOrigin,
      allowedOrigins,
      invalidConfiguredOrigin,
    ),
  );
  results.push(checkProvider(env, config));
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
