import type { Logger } from "../logger.js";
import { inspectWindowsPipeDescriptor } from "./windows-pipe-broker.js";

export type AclCheck = (pipePath: string) => Promise<boolean>;

/**
 * The Windows broker owns the pipe handle, and this independent probe opens
 * that live handle and validates its protected DACL against the probe's
 * current TokenUser and logon SID. Any missing helper/API failure denies
 * readiness. Non-Windows uses a 0600 Unix-domain socket, so the filesystem
 * enforces the equivalent per-user boundary and this check is a passthrough.
 */
export const defaultAclCheck: AclCheck = async (pipePath) => {
  if (process.platform !== "win32") {
    return true;
  }
  try {
    return await inspectWindowsPipeDescriptor(pipePath);
  } catch {
    return false;
  }
};

export async function enforceAcl(
  pipePath: string,
  check: AclCheck,
  logger: Logger,
): Promise<boolean> {
  const ok = await check(pipePath);
  if (!ok) {
    logger.error("bridge pipe ACL check failed; refusing to become ready", { pipePath });
    return false;
  }
  logger.info("bridge pipe ACL check passed", { pipePath });
  return true;
}
