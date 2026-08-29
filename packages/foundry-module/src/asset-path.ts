export interface CanonicalAssetPathOptions {
  allowEmpty?: boolean;
}

export class AssetPathValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetPathValidationError";
  }
}

function invalidPath(message: string): never {
  throw new AssetPathValidationError(message);
}

const WINDOWS_RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * Percent-decodes and validates a relative Foundry asset path using rules that
 * remain safe when a Windows filesystem applies Win32 path canonicalization.
 */
export function canonicalAssetPath(path: string, options: CanonicalAssetPathOptions = {}): string {
  if (path.length === 0 && options.allowEmpty) return "";
  if (path.length === 0) invalidPath("Asset path is required");
  if (path.includes("\0") || path.includes("\\"))
    invalidPath("Asset paths must use relative forward-slash paths");
  if (/^(?:[a-z]:|\/|\\|[a-z][a-z0-9+.-]*:)/i.test(path))
    invalidPath("Absolute, drive-letter, UNC, and URL asset paths are forbidden");

  let decoded = path;
  try {
    for (let pass = 0; pass < 4; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    invalidPath("Asset path contains malformed percent encoding");
  }
  if (/%[0-9a-f]{2}/i.test(decoded))
    invalidPath("Asset path contains excessive nested percent encoding");
  if (decoded.includes("\\") || decoded.startsWith("/"))
    invalidPath("Encoded absolute or backslash asset paths are forbidden");
  if (/^(?:[a-z]:|[a-z][a-z0-9+.-]*:)/i.test(decoded))
    invalidPath("Encoded drive-letter and URL asset paths are forbidden");

  const segments = decoded.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".."))
    invalidPath("Asset path traversal and empty segments are forbidden");
  if (segments.some((segment) => /[. ]$/.test(segment)))
    invalidPath("Asset path segments cannot end with a dot or space on Windows");
  if (segments.some((segment) => WINDOWS_RESERVED_DEVICE_NAME.test(segment)))
    invalidPath("Asset path contains a reserved Windows device name");
  if (
    segments.some(
      (segment) =>
        /[<>:"|?*]/.test(segment) ||
        [...segment].some((character) => (character.codePointAt(0) ?? 0) < 0x20),
    )
  )
    invalidPath("Asset path contains characters unsafe on Windows");
  return decoded;
}
