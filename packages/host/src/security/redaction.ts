const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";

const SECRET_KEYS = new Set([
  "apikey",
  "authorization",
  "credential",
  "credentials",
  "password",
  "privatekey",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "pairingsecret",
]);

export interface RedactionOptions {
  maxDepth?: number;
  maxCollectionItems?: number;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSecretField(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SECRET_KEYS.has(normalized)) {
    return true;
  }
  if (normalized === "tokencount") {
    return false;
  }
  return (
    normalized.endsWith("apikey") ||
    normalized.endsWith("password") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("token")
  );
}

export function redactSecretText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|pairing[_-]?secret|password)\s*[:=]\s*[^\s,;]+/gi,
      `$1=${REDACTED}`,
    );
}

/**
 * Produces a JSON-safe copy with known credential fields and common inline
 * secret forms removed. The input is never mutated.
 */
export function redactSecrets(value: unknown, options: RedactionOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? 12;
  const maxCollectionItems = options.maxCollectionItems ?? 1_000;
  const ancestors = new WeakSet<object>();

  function visit(current: unknown, depth: number): unknown {
    if (typeof current === "string") {
      return redactSecretText(current);
    }
    if (
      current === null ||
      typeof current === "number" ||
      typeof current === "boolean"
    ) {
      return current;
    }
    if (typeof current === "bigint") {
      return current.toString();
    }
    if (typeof current === "undefined" || typeof current === "function" || typeof current === "symbol") {
      return null;
    }
    if (depth >= maxDepth) {
      return TRUNCATED;
    }
    if (current instanceof Date) {
      return current.toISOString();
    }
    if (ancestors.has(current)) {
      return "[CIRCULAR]";
    }

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const result = current.slice(0, maxCollectionItems).map((item) => visit(item, depth + 1));
        if (current.length > maxCollectionItems) {
          result.push(TRUNCATED);
        }
        return result;
      }

      const result: Record<string, unknown> = {};
      const entries = Object.entries(current).slice(0, maxCollectionItems);
      for (const [key, child] of entries) {
        result[key] = isSecretField(key) ? REDACTED : visit(child, depth + 1);
      }
      if (Object.keys(current).length > maxCollectionItems) {
        result[TRUNCATED] = true;
      }
      return result;
    } finally {
      ancestors.delete(current);
    }
  }

  return visit(value, 0);
}
