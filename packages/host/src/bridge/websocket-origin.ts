function normalizedOrigins(origins: readonly string[]): ReadonlySet<string> {
  if (origins.length === 0) {
    throw new Error("at least one exact WebSocket Origin must be configured");
  }
  const normalized = new Set<string>();
  for (const origin of origins) {
    if (origin === "*") {
      throw new Error("wildcard WebSocket Origins are forbidden");
    }
    const url = new URL(origin);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin) {
      throw new Error(`WebSocket Origin must be an exact http(s) origin: ${origin}`);
    }
    normalized.add(url.origin);
  }
  return normalized;
}
/** Fails closed before a WebSocket upgrade when Origin is missing or not exact. */
export function assertAllowedWebSocketOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): string {
  const allowed = normalizedOrigins(allowedOrigins);
  if (!origin) {
    throw new Error("WebSocket Origin header is required");
  }
  let normalized: string;
  try {
    const parsed = new URL(origin);
    normalized = parsed.origin;
    if (parsed.origin !== origin) throw new Error("not an exact origin");
  } catch {
    throw new Error("WebSocket Origin header is malformed");
  }
  if (!allowed.has(normalized)) {
    throw new Error(`WebSocket Origin is not allowed: ${normalized}`);
  }
  return normalized;
}
