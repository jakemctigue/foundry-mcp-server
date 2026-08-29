import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import {
  openDatabase,
  resolveAppDataDir,
  resolvePipePath,
  defaultUserIdentifier,
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
}

function checkConfig(options: DoctorOptions): CheckResult {
  const configPath = options.configPath;
  if (!configPath) {
    return { id: "config", status: "OK", message: "no config file configured, using defaults" };
  }
  if (!fs.existsSync(configPath)) {
    return {
      id: "config",
      status: "WARN",
      message: `config file not found at ${configPath}`,
      hint: "create the config file, or unset the --config flag to use defaults",
    };
  }
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    JSON.parse(raw);
    return { id: "config", status: "OK", message: `config file at ${configPath} is valid JSON` };
  } catch {
    return {
      id: "config",
      status: "FAIL",
      message: `config file at ${configPath} is not valid JSON`,
      hint: `fix or remove the invalid JSON config file at ${configPath}`,
    };
  }
}

function checkDatabase(appDataDir: string): CheckResult {
  const dbPath = path.join(appDataDir, "foundry-mcp.db");
  try {
    fs.mkdirSync(appDataDir, { recursive: true });
    const db = openDatabase(dbPath);
    db.pragma("journal_mode", { simple: true });
    db.close();
    return { id: "database", status: "OK", message: `database reachable at ${dbPath}` };
  } catch (err) {
    return {
      id: "database",
      status: "FAIL",
      message: `could not open database at ${dbPath}: ${String(err)}`,
      hint: "check that the app-data directory is writable and not locked by another process",
    };
  }
}

async function checkPipe(appDataDir: string): Promise<CheckResult> {
  const pipePath = resolvePipePath(defaultUserIdentifier(), appDataDir);
  const connected = await new Promise<boolean>((resolve) => {
    const socket = net.createConnection(pipePath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 500);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });

  if (connected) {
    return { id: "pipe", status: "OK", message: `bridge pipe reachable at ${pipePath}` };
  }
  return {
    id: "pipe",
    status: "WARN",
    message: `bridge pipe not reachable at ${pipePath}`,
    hint: "start the foundry-mcp host daemon before connecting an MCP client",
  };
}

export async function runDoctor(options: DoctorOptions = {}): Promise<CheckResult[]> {
  const appDataDir = options.appDataDir ?? resolveAppDataDir();
  const results: CheckResult[] = [];
  results.push(checkConfig(options));
  results.push(checkDatabase(appDataDir));
  results.push(await checkPipe(appDataDir));
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
    .map((r) => {
      const tag = formatTag(r.status);
      const line = `${tag} ${r.id}: ${r.message}`;
      return r.hint ? `${line}\n       -> ${r.hint}` : line;
    })
    .join("\n");
}

export function formatDoctorJson(results: CheckResult[]): string {
  return JSON.stringify(
    results.map((r) => ({ name: r.id, status: r.status, message: r.message, hint: r.hint })),
    null,
    2,
  );
}
