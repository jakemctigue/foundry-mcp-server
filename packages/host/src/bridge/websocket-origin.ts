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

function normalizedHosts(hosts: readonly string[]): ReadonlySet<string> {
  if (hosts.length === 0) throw new Error("at least one exact WebSocket Host must be configured");
  const normalized = new Set<string>();
  for (const host of hosts) {
    if (host.trim() !== host || host.length === 0 || /[\\/@?#]/.test(host)) {
      throw new Error(`WebSocket Host must be an exact authority: ${host}`);
    }
    let parsed: URL;
    try {
      parsed = new URL(`ws://${host}`);
    } catch {
      throw new Error(`WebSocket Host must be an exact authority: ${host}`);
    }
    if (parsed.host !== host.toLowerCase() || parsed.pathname !== "/") {
      throw new Error(`WebSocket Host must be an exact authority: ${host}`);
    }
    normalized.add(parsed.host);
  }
  return normalized;
}

/** Fails closed before upgrade unless the HTTP Host is an explicitly allowed authority. */
export function assertAllowedWebSocketHost(
  host: string | undefined,
  allowedHosts: readonly string[],
): string {
  const allowed = normalizedHosts(allowedHosts);
  if (!host) throw new Error("WebSocket Host header is required");
  if (host.trim() !== host || /[\\/@?#]/.test(host)) {
    throw new Error("WebSocket Host header is malformed");
  }
  let normalized: string;
  try {
    normalized = new URL(`ws://${host}`).host;
  } catch {
    throw new Error("WebSocket Host header is malformed");
  }
  if (!allowed.has(normalized)) throw new Error(`WebSocket Host is not allowed: ${normalized}`);
  return normalized;
}
