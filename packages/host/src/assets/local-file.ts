import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { MAX_IMAGE_BYTES, inspectImageBytes } from "@foundry-mcp/protocol";

export interface CreateLocalImageLoaderOptions {
  allowedRoots: string[];
  maxBytes?: number;
}

export type LocalImageLoader = (
  filePath: string,
  requestedMaxBytes?: number,
) => Promise<{ bytes: Uint8Array; mimeType: string }>;

export type LocalImageErrorCode =
  | "OUTSIDE_ROOT"
  | "REPARSE_POINT"
  | "SIZE_LIMIT"
  | "NOT_FILE"
  | "CHANGED_DURING_READ"
  | "MIME_MISMATCH"
  | "INVALID_IMAGE"
  | "READ_FAILED";

export class LocalImageError extends Error {
  constructor(
    readonly code: LocalImageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LocalImageError";
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function requirePositiveByteLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Local image byte limit must be a positive safe integer");
  }
  return value;
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.birthtimeMs === right.birthtimeMs
  );
}

async function assertNoReparseSegments(root: string, candidate: string): Promise<void> {
  const relative = path.relative(root, candidate);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if ((await fs.lstat(current)).isSymbolicLink()) {
      throw new LocalImageError(
        "REPARSE_POINT",
        "Local image path contains a symbolic link or junction",
      );
    }
  }
}

async function readBounded(handle: fs.FileHandle, maxBytes: number): Promise<Uint8Array> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maxBytes)
    throw new LocalImageError(
      "SIZE_LIMIT",
      `Local image exceeds the ${maxBytes.toString()} byte limit`,
    );
  return Uint8Array.from(buffer.subarray(0, offset));
}

export function createLocalImageLoader(options: CreateLocalImageLoaderOptions): LocalImageLoader {
  const lexicalRoots = options.allowedRoots.map((root) => path.resolve(root));
  const configuredMax = requirePositiveByteLimit(options.maxBytes ?? MAX_IMAGE_BYTES);
  if (lexicalRoots.length === 0)
    throw new Error("At least one local image root must be configured");
  let rootsPromise: Promise<Array<{ lexical: string; canonical: string }>> | undefined;
  const roots = () =>
    (rootsPromise ??= Promise.all(
      lexicalRoots.map(async (lexical) => ({ lexical, canonical: await fs.realpath(lexical) })),
    ));
  return async (filePath, requestedMaxBytes) => {
    try {
      const resolved = path.resolve(filePath);
      const configuredRoots = await roots();
      const root = configuredRoots.find((candidate) => isWithin(candidate.lexical, resolved));
      if (!root)
        throw new LocalImageError("OUTSIDE_ROOT", "Local image path is outside configured roots");
      const requested = requirePositiveByteLimit(requestedMaxBytes ?? configuredMax);
      const maxBytes = Math.min(requested, configuredMax);
      await assertNoReparseSegments(root.lexical, resolved);
      const canonicalBeforeOpen = await fs.realpath(resolved);
      if (!isWithin(root.canonical, canonicalBeforeOpen)) {
        throw new LocalImageError(
          "OUTSIDE_ROOT",
          "Local image path resolves outside configured roots",
        );
      }

      const handle = await fs.open(resolved, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile())
          throw new LocalImageError("NOT_FILE", "Local image path is not a file");
        if (opened.size > maxBytes) {
          throw new LocalImageError(
            "SIZE_LIMIT",
            `Local image exceeds the ${maxBytes.toString()} byte limit`,
          );
        }

        const canonicalAfterOpen = await fs.realpath(resolved);
        if (!isWithin(root.canonical, canonicalAfterOpen)) {
          throw new LocalImageError(
            "OUTSIDE_ROOT",
            "Local image path resolves outside configured roots",
          );
        }
        const current = await fs.stat(resolved);
        if (!sameFile(opened, current)) {
          throw new LocalImageError(
            "CHANGED_DURING_READ",
            "Local image path changed while it was being authorized",
          );
        }

        const bytes = await readBounded(handle, maxBytes);
        const inspected = inspectImageBytes(bytes, {
          expectedExtension: path.extname(canonicalAfterOpen),
          maxBytes,
          requireDimensions: true,
        });
        if (!inspected.ok) {
          const code = inspected.reason.includes("does not match")
            ? "MIME_MISMATCH"
            : "INVALID_IMAGE";
          throw new LocalImageError(code, inspected.reason);
        }
        return { bytes, mimeType: inspected.value.mimeType };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof LocalImageError) throw error;
      throw new LocalImageError("READ_FAILED", "Local image could not be read safely");
    }
  };
}
