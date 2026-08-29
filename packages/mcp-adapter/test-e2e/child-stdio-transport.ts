import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAppDataDir, startDaemon, type Daemon, type PlatformEnv } from "@foundry-mcp/host";
import {
  parseJSONRPCMessage,
  serializeMessage,
  type JSONRPCMessage,
  type Transport,
} from "@modelcontextprotocol/client";

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Test-only MCP transport that talks to the built adapter over real process
 * stdio while retaining every raw stdout line for protocol-purity assertions.
 */
export class CapturingChildStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  readonly stdoutLines: string[] = [];
  readonly protocolErrors: Error[] = [];
  readonly stderrChunks: string[] = [];

  private child: ChildProcessWithoutNullStreams | undefined;
  private daemon: Daemon | undefined;
  private tempRoot: string | undefined;
  private buffer = "";
  private exitResult: ChildExit | undefined;
  private readonly exitPromise: Promise<ChildExit>;
  private resolveExit!: (result: ChildExit) => void;

  constructor(
    private readonly entry: string,
    private readonly cwd: string,
  ) {
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  get stderrText(): string {
    return this.stderrChunks.join("");
  }

  async start(): Promise<void> {
    if (this.child) throw new Error("child stdio transport already started");

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fmcp-adapter-child-"));
    this.tempRoot = tempRoot;
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (process.platform === "win32") {
      env["LOCALAPPDATA"] = tempRoot;
    } else {
      env["XDG_DATA_HOME"] = tempRoot;
    }
    const pipeName = path.basename(tempRoot);
    env["FOUNDRY_MCP_PIPE_NAME"] = pipeName;
    const platformEnv: PlatformEnv = {
      platform: process.platform,
      env,
      homedir: () => tempRoot,
    };
    try {
      const appDataDir = resolveAppDataDir(platformEnv);
      this.daemon = await startDaemon({
        appDataDir,
        cliConfig: { dbPath: "child-e2e.db", pipeName },
        companionPairingSecret: Buffer.alloc(32, 0x5a),
      });

      const child = spawn(process.execPath, [this.entry], {
        cwd: this.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
      child.stdout.on("end", () => this.flushStdout());
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => this.stderrChunks.push(chunk));
      child.once("error", (error) => this.reportError(error));
      child.once("close", (code, signal) => {
        const result = { code, signal };
        this.exitResult = result;
        this.resolveExit(result);
        this.onclose?.();
      });
    } catch (error) {
      await this.cleanupDaemon();
      throw error;
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.child;
    if (!child?.stdin.writable) throw new Error("child stdin is not writable");

    await new Promise<void>((resolve, reject) => {
      child.stdin.write(serializeMessage(message), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    try {
      if (child && !this.exitResult) {
        child.stdin.end();
        try {
          await this.waitForExit(5000);
        } catch (error) {
          child.kill();
          await this.exitPromise;
          throw error;
        }
      }
    } finally {
      await this.cleanupDaemon();
    }
  }

  async waitForExit(timeoutMs = 5000): Promise<ChildExit> {
    if (this.exitResult) return this.exitResult;

    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.exitPromise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`child did not exit within ${timeoutMs.toString()}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private consumeStdout(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private flushStdout(): void {
    if (this.buffer.length > 0) {
      const line = this.buffer.replace(/\r$/, "");
      this.buffer = "";
      this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    this.stdoutLines.push(line);
    try {
      const message = parseJSONRPCMessage(JSON.parse(line));
      this.onmessage?.(message);
    } catch (cause) {
      const error = new Error(`non-protocol stdout line: ${line}`, { cause });
      this.protocolErrors.push(error);
      this.reportError(error);
    }
  }

  private reportError(error: Error): void {
    this.onerror?.(error);
  }

  private async cleanupDaemon(): Promise<void> {
    const daemon = this.daemon;
    const tempRoot = this.tempRoot;
    this.daemon = undefined;
    this.tempRoot = undefined;
    const resolvedRoot = tempRoot ? path.resolve(tempRoot) : undefined;
    const resolvedTemp = path.resolve(os.tmpdir());
    const safeToDelete = resolvedRoot?.startsWith(`${resolvedTemp}${path.sep}`) ?? false;
    try {
      await daemon?.shutdown();
    } finally {
      if (resolvedRoot && safeToDelete) {
        fs.rmSync(resolvedRoot, { recursive: true, force: true });
      }
    }
    if (resolvedRoot && !safeToDelete) {
      throw new Error("refusing to remove child-test data outside the temp directory");
    }
  }
}
