import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";

export function userSidHash(userIdentifier: string): string {
  return crypto.createHash("sha256").update(userIdentifier).digest("hex").slice(0, 16);
}

/**
 * Resolves the bridge transport path. On Windows this is a named pipe
 * following \\.\pipe\foundry-mcp-<userSID-hash>. On other platforms this is
 * a Unix domain socket under the given app-data directory, documented as
 * the cross-platform dev equivalent.
 */
export function resolvePipePath(
  userIdentifier: string,
  appDataDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const hash = userSidHash(userIdentifier);
  if (platform === "win32") {
    return `\\\\.\\pipe\\foundry-mcp-${hash}`;
  }
  return path.join(appDataDir, `foundry-mcp-${hash}.sock`);
}

export function defaultUserIdentifier(): string {
  return os.userInfo().username;
}
