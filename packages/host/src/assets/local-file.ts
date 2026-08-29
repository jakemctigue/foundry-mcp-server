import fs from "node:fs/promises";
import path from "node:path";

import { MAX_IMAGE_BYTES, inspectImageBytes } from "@foundry-mcp/protocol";

export interface CreateLocalImageLoaderOptions {
  allowedRoots: string[];
  maxBytes?: number;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function createLocalImageLoader(
  options: CreateLocalImageLoaderOptions,
): (
  filePath: string,
  requestedMaxBytes?: number,
) => Promise<{ bytes: Uint8Array; mimeType: string }> {
  const roots = options.allowedRoots.map((root) => path.resolve(root));
  const configuredMax = options.maxBytes ?? MAX_IMAGE_BYTES;
  if (roots.length === 0) throw new Error("At least one local image root must be configured");
  return async (filePath, requestedMaxBytes) => {
    const resolved = path.resolve(filePath);
    if (!roots.some((root) => isWithin(root, resolved)))
      throw new Error("Local image path is outside configured roots");
    const maxBytes = Math.min(requestedMaxBytes ?? configuredMax, configuredMax);
    const metadata = await fs.stat(resolved);
    if (!metadata.isFile()) throw new Error("Local image path is not a file");
    if (metadata.size > maxBytes)
      throw new Error(`Local image exceeds the ${maxBytes.toString()} byte limit`);
    const bytes = Uint8Array.from(await fs.readFile(resolved));
    const inspected = inspectImageBytes(bytes, {
      expectedExtension: path.extname(resolved),
      maxBytes,
      requireDimensions: true,
    });
    if (!inspected.ok) throw new Error(inspected.reason);
    return { bytes, mimeType: inspected.value.mimeType };
  };
}
