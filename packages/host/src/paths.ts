import path from "node:path";
import os from "node:os";

export interface PlatformEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homedir: () => string;
}

const defaultPlatformEnv: PlatformEnv = {
  platform: process.platform,
  env: process.env,
  homedir: () => os.homedir(),
};

/**
 * Resolves the per-user application-data directory. On Windows this prefers
 * %LOCALAPPDATA%, falling back to %APPDATA%. On other platforms this is a
 * documented dev-only fallback under the user's home directory, since
 * Windows is the only first-class packaging target.
 */
export function resolveAppDataDir(platformEnv: PlatformEnv = defaultPlatformEnv): string {
  const { platform, env, homedir } = platformEnv;

  if (platform === "win32") {
    const base = env["LOCALAPPDATA"] ?? env["APPDATA"];
    if (base && base.length > 0) {
      return path.win32.join(base, "foundry-mcp");
    }
    return path.win32.join(homedir(), "AppData", "Local", "foundry-mcp");
  }

  if (platform === "darwin") {
    return path.posix.join(homedir(), "Library", "Application Support", "foundry-mcp");
  }

  const xdg = env["XDG_DATA_HOME"];
  if (xdg && xdg.length > 0) {
    return path.posix.join(xdg, "foundry-mcp");
  }
  return path.posix.join(homedir(), ".local", "share", "foundry-mcp");
}
