export interface DoctorCommandOptions {
  json: boolean;
  allowedOrigins: string[];
  appDataDir?: string;
  configPath?: string;
  foundryUserDataPath?: string;
  dockerUserDataPath?: string;
  bridgeUrl?: string;
  foundryOrigin?: string;
  moduleId?: string;
}

export interface BuildModuleCommandOptions {
  json: boolean;
  outputDir?: string;
  version?: string;
}

export interface HostCommandOptions {
  allowedOrigins: string[];
  localAssetRoots?: string[];
  appDataDir?: string;
  configPath?: string;
  port?: string;
  pipeName?: string;
  logLevel?: string;
}

export interface CapabilityCommandOptions {
  action: "list" | "grant" | "revoke";
  connectionId: string;
  json: boolean;
  appDataDir?: string;
  configPath?: string;
  role?: string;
  capability?: string;
}

export interface ProviderCommandOptions {
  action: "configure" | "remove" | "status";
  json: boolean;
  appDataDir?: string;
}

export type ParsedCommandLine =
  | { command: "doctor"; options: DoctorCommandOptions }
  | { command: "build-module"; options: BuildModuleCommandOptions }
  | { command: "host"; options: HostCommandOptions }
  | { command: "capabilities"; options: CapabilityCommandOptions }
  | { command: "provider"; options: ProviderCommandOptions };

type OptionCardinality = "boolean" | "scalar" | "repeatable";
type ParsedOption = boolean | string | string[];

function parseOptions(
  args: readonly string[],
  specification: Readonly<Record<string, OptionCardinality>>,
): Record<string, ParsedOption> {
  const parsed: Record<string, ParsedOption> = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag || !flag.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${flag ?? "(missing)"}`);
    }
    const cardinality = specification[flag];
    if (!cardinality) throw new Error(`unknown flag: ${flag}`);

    if (cardinality === "boolean") {
      if (Object.hasOwn(parsed, flag)) throw new Error(`${flag} may only be specified once`);
      parsed[flag] = true;
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    index += 1;
    if (cardinality === "scalar") {
      if (Object.hasOwn(parsed, flag)) throw new Error(`${flag} may only be specified once`);
      parsed[flag] = value;
      continue;
    }

    const values = parsed[flag];
    if (values === undefined) parsed[flag] = [value];
    else if (Array.isArray(values)) values.push(value);
    else throw new Error(`internal option cardinality error for ${flag}`);
  }
  return parsed;
}

function scalar(options: Record<string, ParsedOption>, flag: string): string | undefined {
  const value = options[flag];
  return typeof value === "string" ? value : undefined;
}

function repeated(options: Record<string, ParsedOption>, flag: string): string[] {
  const value = options[flag];
  return Array.isArray(value) ? value : [];
}

function enabled(options: Record<string, ParsedOption>, flag: string): boolean {
  return options[flag] === true;
}

function parseDoctor(args: readonly string[]): DoctorCommandOptions {
  const parsed = parseOptions(args, {
    "--json": "boolean",
    "--app-data": "scalar",
    "--config": "scalar",
    "--foundry-data": "scalar",
    "--docker-data": "scalar",
    "--bridge-url": "scalar",
    "--foundry-origin": "scalar",
    "--module-id": "scalar",
    "--allow-origin": "repeatable",
  });
  const foundryUserDataPath = scalar(parsed, "--foundry-data");
  const dockerUserDataPath = scalar(parsed, "--docker-data");
  if (foundryUserDataPath && dockerUserDataPath) {
    throw new Error("--foundry-data and --docker-data are mutually exclusive");
  }
  const result: DoctorCommandOptions = {
    json: enabled(parsed, "--json"),
    allowedOrigins: repeated(parsed, "--allow-origin"),
  };
  const appDataDir = scalar(parsed, "--app-data");
  const configPath = scalar(parsed, "--config");
  const bridgeUrl = scalar(parsed, "--bridge-url");
  const foundryOrigin = scalar(parsed, "--foundry-origin");
  const moduleId = scalar(parsed, "--module-id");
  if (appDataDir) result.appDataDir = appDataDir;
  if (configPath) result.configPath = configPath;
  if (foundryUserDataPath) result.foundryUserDataPath = foundryUserDataPath;
  if (dockerUserDataPath) result.dockerUserDataPath = dockerUserDataPath;
  if (bridgeUrl) result.bridgeUrl = bridgeUrl;
  if (foundryOrigin) result.foundryOrigin = foundryOrigin;
  if (moduleId) result.moduleId = moduleId;
  return result;
}

function parseBuildModule(args: readonly string[]): BuildModuleCommandOptions {
  const parsed = parseOptions(args, {
    "--json": "boolean",
    "--output": "scalar",
    "--version": "scalar",
  });
  const result: BuildModuleCommandOptions = {
    json: enabled(parsed, "--json"),
  };
  const outputDir = scalar(parsed, "--output");
  const version = scalar(parsed, "--version");
  if (outputDir) result.outputDir = outputDir;
  if (version) result.version = version;
  return result;
}

function parseHost(args: readonly string[]): HostCommandOptions {
  const parsed = parseOptions(args, {
    "--app-data": "scalar",
    "--config": "scalar",
    "--port": "scalar",
    "--pipe-name": "scalar",
    "--log-level": "scalar",
    "--allow-origin": "repeatable",
    "--allow-local-asset-root": "repeatable",
  });
  const result: HostCommandOptions = {
    allowedOrigins: repeated(parsed, "--allow-origin"),
    localAssetRoots: repeated(parsed, "--allow-local-asset-root"),
  };
  const appDataDir = scalar(parsed, "--app-data");
  const configPath = scalar(parsed, "--config");
  const port = scalar(parsed, "--port");
  const pipeName = scalar(parsed, "--pipe-name");
  const logLevel = scalar(parsed, "--log-level");
  if (appDataDir) result.appDataDir = appDataDir;
  if (configPath) result.configPath = configPath;
  if (port) result.port = port;
  if (pipeName) result.pipeName = pipeName;
  if (logLevel) result.logLevel = logLevel;
  return result;
}

function parseCapabilities(args: readonly string[]): CapabilityCommandOptions {
  const [action, ...optionArgs] = args;
  if (action !== "list" && action !== "grant" && action !== "revoke") {
    throw new Error(`unknown capabilities action: ${action ?? "(none)"}`);
  }
  const parsed = parseOptions(optionArgs, {
    "--json": "boolean",
    "--app-data": "scalar",
    "--config": "scalar",
    "--connection-id": "scalar",
    "--role": "scalar",
    "--capability": "scalar",
  });
  const connectionId = scalar(parsed, "--connection-id");
  if (!connectionId) throw new Error("--connection-id is required");
  const role = scalar(parsed, "--role");
  const capability = scalar(parsed, "--capability");
  if (action !== "list" && (!role || !capability)) {
    throw new Error(`capabilities ${action} requires --role and --capability`);
  }
  if (action === "list" && (role || capability)) {
    throw new Error("capabilities list does not accept --role or --capability");
  }
  const result: CapabilityCommandOptions = {
    action,
    connectionId,
    json: enabled(parsed, "--json"),
  };
  const appDataDir = scalar(parsed, "--app-data");
  const configPath = scalar(parsed, "--config");
  if (appDataDir) result.appDataDir = appDataDir;
  if (configPath) result.configPath = configPath;
  if (role) result.role = role;
  if (capability) result.capability = capability;
  return result;
}

function parseProvider(args: readonly string[]): ProviderCommandOptions {
  const [action, ...optionArgs] = args;
  if (action !== "configure" && action !== "remove" && action !== "status") {
    throw new Error(`unknown provider action: ${action ?? "(none)"}`);
  }
  const parsed = parseOptions(optionArgs, {
    "--json": "boolean",
    "--app-data": "scalar",
  });
  const result: ProviderCommandOptions = {
    action,
    json: enabled(parsed, "--json"),
  };
  const appDataDir = scalar(parsed, "--app-data");
  if (appDataDir) result.appDataDir = appDataDir;
  return result;
}

export function parseCommandLine(argv: readonly string[]): ParsedCommandLine {
  const [command, ...args] = argv;
  if (command === "doctor") return { command, options: parseDoctor(args) };
  if (command === "build-module") return { command, options: parseBuildModule(args) };
  if (command === "host") return { command, options: parseHost(args) };
  if (command === "capabilities") return { command, options: parseCapabilities(args) };
  if (command === "provider") return { command, options: parseProvider(args) };
  throw new Error(`unknown command: ${command ?? "(none)"}`);
}
