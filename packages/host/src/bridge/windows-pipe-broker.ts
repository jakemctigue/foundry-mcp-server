import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { Logger } from "../logger.js";

const BROKER_PROTOCOL = 1;
const STARTUP_TIMEOUT_MS = 15_000;

interface BrokerInvocation {
  command: string;
  prefixArgs: string[];
  executablePath: string;
}

export interface BrokerReadyIdentity {
  ownerSid: string;
  logonSid: string;
  descriptorVerified: true;
  remoteClientsRejected: true;
  firstInstance: true;
  descriptorSddl: string;
}

export interface BrokerClientIdentity {
  connectionId: string;
  clientUserSid: string;
  clientLogonSid: string;
  tokenVerified: true;
}

interface BrokerReadyEvent extends BrokerReadyIdentity {
  type: "ready";
  protocol: number;
}

interface BrokerConnectedEvent extends BrokerClientIdentity {
  type: "connected";
}

interface BrokerDataEvent {
  type: "data";
  connectionId: string;
  data: string;
}

interface BrokerDisconnectedEvent {
  type: "disconnected";
  connectionId: string;
}

interface BrokerRejectedEvent {
  type: "rejected";
  connectionId: string;
  reason?: string;
}

type BrokerEvent =
  | BrokerReadyEvent
  | BrokerConnectedEvent
  | BrokerDataEvent
  | BrokerDisconnectedEvent
  | BrokerRejectedEvent;

export interface WindowsPipeBrokerOptions {
  pipePath: string;
  logger: Logger;
  executablePath?: string | undefined;
  onConnected: (identity: BrokerClientIdentity) => void | Promise<void>;
  onData: (connectionId: string, data: Buffer) => void | Promise<void>;
  onDisconnected: (connectionId: string) => void | Promise<void>;
}

export interface WindowsPipeBrokerHandle {
  identity: BrokerReadyIdentity;
  send: (connectionId: string, data: Buffer) => void;
  closeConnection: (connectionId: string) => void;
  close: () => Promise<void>;
}

function runtimeIdentifier(): "win-x64" | "win-arm64" {
  if (process.arch === "x64") {
    return "win-x64";
  }
  if (process.arch === "arm64") {
    return "win-arm64";
  }
  throw new Error(`unsupported Windows broker architecture: ${process.arch}`);
}

function hostRootCandidates(): string[] {
  const candidates = [
    path.resolve(process.cwd(), "packages", "host"),
    process.cwd(),
    fileURLToPath(new URL("../../", import.meta.url)),
    fileURLToPath(new URL("../", import.meta.url)),
  ];
  return [...new Set(candidates)];
}

export function resolveWindowsPipeBrokerInvocation(
  explicitPath: string | undefined = process.env["FOUNDRY_MCP_PIPE_BROKER_PATH"],
): BrokerInvocation {
  const rid = runtimeIdentifier();
  const candidates = explicitPath
    ? [path.resolve(explicitPath)]
    : hostRootCandidates().flatMap((root) => [
        path.join(root, "native", "bin", rid, "foundry-mcp-pipe-broker.exe"),
        path.join(
          root,
          "native",
          "windows-pipe-broker",
          "bin",
          "Release",
          "net8.0",
          "foundry-mcp-pipe-broker.exe",
        ),
      ]);
  const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executablePath) {
    throw new Error(
      `Windows pipe broker was not found for ${rid}; publish it or set FOUNDRY_MCP_PIPE_BROKER_PATH`,
    );
  }
  if (path.extname(executablePath).toLowerCase() === ".dll") {
    return { command: "dotnet", prefixArgs: [executablePath], executablePath };
  }
  return { command: executablePath, prefixArgs: [], executablePath };
}

function spawnBroker(
  mode: "serve" | "inspect",
  pipePath: string,
  executablePath?: string,
  extraArgs: string[] = [],
): { child: ChildProcessWithoutNullStreams; invocation: BrokerInvocation } {
  const invocation = resolveWindowsPipeBrokerInvocation(executablePath);
  const child = spawn(
    invocation.command,
    [...invocation.prefixArgs, mode, "--pipe", pipePath, ...extraArgs],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  return { child, invocation };
}

function writeCommand(
  child: ChildProcessWithoutNullStreams,
  command: object,
  onError: (error: Error) => void,
): void {
  if (!child.stdin.destroyed && !child.stdin.writableEnded && !child.stdin.writableFinished) {
    try {
      child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
        if (error) {
          onError(error);
        }
      });
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function isReadyEvent(value: unknown): value is BrokerReadyEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const event = value as Partial<BrokerReadyEvent>;
  return (
    event.type === "ready" &&
    event.protocol === BROKER_PROTOCOL &&
    typeof event.ownerSid === "string" &&
    typeof event.logonSid === "string" &&
    event.descriptorVerified === true &&
    event.remoteClientsRejected === true &&
    event.firstInstance === true &&
    typeof event.descriptorSddl === "string"
  );
}

export async function startWindowsPipeBroker(
  options: WindowsPipeBrokerOptions,
): Promise<WindowsPipeBrokerHandle> {
  const { child, invocation } = spawnBroker("serve", options.pipePath, options.executablePath);
  const stdout = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const stderr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
  stderr.on("line", (line) => {
    options.logger.debug("Windows pipe broker diagnostic", { diagnostic: line });
  });

  let settled = false;
  let closing = false;
  let controlFailed = false;
  let closePromise: Promise<void> | undefined;
  let readyIdentity: BrokerReadyIdentity | undefined;
  let eventChain = Promise.resolve();
  let resolveReady: ((identity: BrokerReadyIdentity) => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const ready = new Promise<BrokerReadyIdentity>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  function failControlChannel(error: Error): void {
    if (closing || controlFailed) {
      return;
    }
    controlFailed = true;
    options.logger.error("Windows pipe broker control channel failed closed", {
      error: error.message,
    });
    child.kill();
    if (!settled) {
      settled = true;
      clearTimeout(startupTimer);
      rejectReady?.(error);
    }
  }

  const startupTimer = setTimeout(() => {
    if (!settled) {
      settled = true;
      child.kill();
      rejectReady?.(new Error("Windows pipe broker did not become ready before the timeout"));
    }
  }, STARTUP_TIMEOUT_MS);
  startupTimer.unref();

  async function handleEvent(event: BrokerEvent): Promise<void> {
    if (event.type === "ready") {
      if (!isReadyEvent(event) || readyIdentity) {
        throw new Error("Windows pipe broker returned an invalid or duplicate ready event");
      }
      readyIdentity = event;
      if (!settled) {
        settled = true;
        clearTimeout(startupTimer);
        resolveReady?.(event);
      }
      return;
    }
    if (!readyIdentity) {
      throw new Error(
        "Windows pipe broker emitted a connection event before descriptor verification",
      );
    }
    if (event.type === "connected") {
      if (
        typeof event.connectionId !== "string" ||
        typeof event.clientUserSid !== "string" ||
        typeof event.clientLogonSid !== "string" ||
        event.tokenVerified !== true
      ) {
        throw new Error("Windows pipe broker returned invalid client-token metadata");
      }
      await options.onConnected(event);
      return;
    }
    if (event.type === "data") {
      if (typeof event.connectionId !== "string" || typeof event.data !== "string") {
        throw new Error("Windows pipe broker returned an invalid data event");
      }
      await options.onData(event.connectionId, Buffer.from(event.data, "base64"));
      return;
    }
    if (event.type === "disconnected") {
      await options.onDisconnected(event.connectionId);
      return;
    }
    if (event.type === "rejected") {
      options.logger.warn("Windows pipe broker rejected a client token", {
        connectionId: event.connectionId,
        reason: event.reason ?? "token mismatch",
      });
    }
  }

  stdout.on("line", (line) => {
    eventChain = eventChain
      .then(async () => {
        const parsed = JSON.parse(line) as BrokerEvent;
        await handleEvent(parsed);
      })
      .catch((error: unknown) => {
        options.logger.error("Windows pipe broker control protocol failed closed", {
          error: error instanceof Error ? error.message : String(error),
        });
        child.kill();
        if (!settled) {
          settled = true;
          clearTimeout(startupTimer);
          rejectReady?.(error instanceof Error ? error : new Error(String(error)));
        }
      });
  });

  child.once("error", (error) => {
    if (!settled) {
      settled = true;
      clearTimeout(startupTimer);
      rejectReady?.(error);
    }
  });
  child.stdin.on("error", failControlChannel);
  child.once("exit", (code, signal) => {
    if (!settled) {
      settled = true;
      clearTimeout(startupTimer);
      rejectReady?.(
        new Error(
          `Windows pipe broker exited before ready (code=${String(code)}, signal=${String(signal)})`,
        ),
      );
      return;
    }
    if (code !== 0 && signal === null) {
      options.logger.error("Windows pipe broker exited unexpectedly", { code });
    }
  });

  const identity = await ready;
  options.logger.info("Windows pipe broker descriptor verified", {
    broker: invocation.executablePath,
    ownerSid: identity.ownerSid,
    logonSid: identity.logonSid,
  });

  return {
    identity,
    send: (connectionId, data) => {
      if (closing) return;
      writeCommand(
        child,
        { type: "data", connectionId, data: data.toString("base64") },
        failControlChannel,
      );
    },
    closeConnection: (connectionId) => {
      if (closing) return;
      writeCommand(child, { type: "close", connectionId }, failControlChannel);
    },
    close: () => {
      closePromise ??= (async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        closing = true;
        writeCommand(child, { type: "shutdown" }, failControlChannel);
        child.stdin.end();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            child.kill();
            resolve();
          }, 5_000);
          timer.unref();
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      })();
      return closePromise;
    },
  };
}

interface InspectionEvent {
  type: "inspection";
  protocol: number;
  verified: boolean;
}

export async function inspectWindowsPipeDescriptor(
  pipePath: string,
  options: {
    executablePath?: string;
    expectedUserSid?: string;
    expectedLogonSid?: string;
  } = {},
): Promise<boolean> {
  const extraArgs: string[] = [];
  if (options.expectedUserSid) {
    extraArgs.push("--expected-user-sid", options.expectedUserSid);
  }
  if (options.expectedLogonSid) {
    extraArgs.push("--expected-logon-sid", options.expectedLogonSid);
  }
  const { child } = spawnBroker("inspect", pipePath, options.executablePath, extraArgs);
  const stdout = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let inspection: InspectionEvent | undefined;
  stdout.on("line", (line) => {
    const parsed = JSON.parse(line) as InspectionEvent;
    if (parsed.type === "inspection" && parsed.protocol === BROKER_PROTOCOL) {
      inspection = parsed;
    }
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return code === 0 && inspection?.verified === true;
}
