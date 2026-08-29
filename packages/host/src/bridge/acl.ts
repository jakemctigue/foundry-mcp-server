import type { Logger } from "../logger.js";

export type AclCheck = (pipePath: string) => Promise<boolean>;

/**
 * Default ACL check: on non-Windows platforms Unix domain socket
 * permissions are enforced by the filesystem mode set at creation time, so
 * this always passes. On Windows a real implementation would inspect the
 * pipe's security descriptor to confirm it is restricted to the current
 * user; that check is injected as `AclCheck` so tests can simulate failure.
 */
export const defaultAclCheck: AclCheck = () => Promise.resolve(true);

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
