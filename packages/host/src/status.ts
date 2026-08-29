import fs from "node:fs";
import path from "node:path";
import { BRIDGE_PROTOCOL_VERSION } from "@foundry-mcp/protocol";

export interface HostStatusSnapshot {
  state: "running" | "stopped";
  activeConnections: number;
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  updatedAt: string;
}

/** Writes the deliberately minimal, secret-free doctor snapshot atomically. */
export function writeHostStatusAtomic(
  statusPath: string,
  status: Omit<HostStatusSnapshot, "protocolVersion" | "updatedAt">,
  now: Date = new Date(),
): HostStatusSnapshot {
  if (!Number.isSafeInteger(status.activeConnections) || status.activeConnections < 0) {
    throw new Error("host status activeConnections must be a non-negative integer");
  }
  const snapshot: HostStatusSnapshot = {
    ...status,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    updatedAt: now.toISOString(),
  };
  const directory = path.dirname(statusPath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(statusPath)}.${process.pid.toString()}.${now.getTime().toString()}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(tempPath, statusPath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup of a fully scoped temporary file.
    }
    throw error;
  }
  return snapshot;
}
