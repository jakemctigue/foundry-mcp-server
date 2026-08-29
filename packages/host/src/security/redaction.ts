const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const REDACTED_FOUNDRY_SECRET = "[REDACTED FOUNDRY SECRET]";

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

/**
 * Removes Foundry's native HTML secret blocks before text can enter search,
 * context packs, or a provider request. Malformed/unclosed secret blocks are
 * redacted through the end of the string (fail closed).
 */
export function redactFoundrySecretBlocks(value: string): string {
  const openingTag = /<([a-z][\w:-]*)\b[^>]*>/gi;
  let cursor = 0;
  let output = "";
  for (let match = openingTag.exec(value); match; match = openingTag.exec(value)) {
    const tag = match[1];
    if (!tag) continue;
    const classAttribute = match[0].match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const classes = (classAttribute?.[1] ?? classAttribute?.[2] ?? "").split(/\s+/).filter(Boolean);
    if (!classes.includes("secret")) continue;

    output += value.slice(cursor, match.index);
    const tagToken = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
    tagToken.lastIndex = openingTag.lastIndex;
    let depth = 1;
    let end = value.length;
    for (let token = tagToken.exec(value); token; token = tagToken.exec(value)) {
      if (/^<\//.test(token[0])) depth -= 1;
      else if (!/\/>$/.test(token[0])) depth += 1;
      if (depth === 0) {
        end = tagToken.lastIndex;
        break;
      }
    }
    output += REDACTED_FOUNDRY_SECRET;
    cursor = end;
    openingTag.lastIndex = end;
  }
  return cursor === 0 ? value : output + value.slice(cursor);
}

export function redactSecretText(value: string): string {
  return redactFoundrySecretBlocks(value)
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
    if (current === null || typeof current === "number" || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "bigint") {
      return current.toString();
    }
    if (
      typeof current === "undefined" ||
      typeof current === "function" ||
      typeof current === "symbol"
    ) {
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
