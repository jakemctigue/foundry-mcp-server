import type { AssetSourceCapability } from "@foundry-mcp/protocol";
import type {
  FoundryAssetRuntimeAdapter,
  RuntimeAssetBrowseResult,
  RuntimeDecodedImage,
  RuntimeImageDecodeLimits,
  RuntimeAssetUploadResult,
} from "../../src/asset-runtime.js";

interface FakeAsset {
  bytes: Uint8Array;
  mimeType: string;
}

interface FakeAssetSource extends AssetSourceCapability {
  files: Map<string, FakeAsset>;
}

interface FakeAssetSnapshot {
  sources: Array<{
    id: string;
    files: Array<[string, { bytes: number[]; mimeType: string }]>;
  }>;
  uploadCalls: number;
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

function normalize(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

export class FakeFoundryAssetRuntime implements FoundryAssetRuntimeAdapter {
  online = true;
  uploadCalls = 0;
  decodeCalls = 0;
  readonly #sources = new Map<string, FakeAssetSource>();

  addSource(capability: AssetSourceCapability): this {
    this.#sources.set(capability.id, { ...capability, files: new Map() });
    return this;
  }

  seed(sourceId: string, path: string, bytes: Uint8Array, mimeType: string): this {
    const source = this.#sources.get(sourceId);
    if (!source) throw new Error(`Unknown fake asset source ${sourceId}`);
    source.files.set(normalize(path), { bytes: cloneBytes(bytes), mimeType });
    return this;
  }

  get(sourceId: string, path: string): { bytes: Uint8Array; mimeType: string } | undefined {
    const value = this.#sources.get(sourceId)?.files.get(normalize(path));
    return value ? { bytes: cloneBytes(value.bytes), mimeType: value.mimeType } : undefined;
  }

  isOnline(): boolean {
    return this.online;
  }

  async listSources(): Promise<AssetSourceCapability[]> {
    return [...this.#sources.values()].map((source) => ({
      id: source.id,
      writable: source.writable,
      ...(source.reason ? { reason: source.reason } : {}),
    }));
  }

  async getWriteCapability(
    sourceId: string,
    _destinationPath: string,
  ): Promise<AssetSourceCapability> {
    const source = this.#sources.get(sourceId);
    if (!source)
      return { id: sourceId, writable: false, reason: `Unknown fake asset source ${sourceId}` };
    return {
      id: source.id,
      writable: source.writable,
      ...(source.reason ? { reason: source.reason } : {}),
    };
  }

  async browse(
    sourceId: string,
    path: string,
    extensions?: string[],
  ): Promise<RuntimeAssetBrowseResult> {
    const source = this.#sources.get(sourceId);
    if (!source) throw new Error(`Unknown fake asset source ${sourceId}`);
    const prefix = normalize(path);
    const prefixWithSlash = prefix ? `${prefix}/` : "";
    const directories = new Set<string>();
    const entries: RuntimeAssetBrowseResult["entries"] = [];
    for (const [filePath, file] of source.files) {
      if (!filePath.startsWith(prefixWithSlash)) continue;
      const remainder = filePath.slice(prefixWithSlash.length);
      const slash = remainder.indexOf("/");
      if (slash >= 0) {
        directories.add(`${prefixWithSlash}${remainder.slice(0, slash)}`);
        continue;
      }
      if (
        extensions &&
        !extensions.some((extension) => filePath.toLocaleLowerCase().endsWith(extension))
      )
        continue;
      entries.push({
        path: filePath,
        kind: "file",
        size: file.bytes.byteLength,
        mimeType: file.mimeType,
      });
    }
    entries.push(
      ...[...directories].map((directory) => ({ path: directory, kind: "directory" as const })),
    );
    return { entries };
  }

  async exists(sourceId: string, path: string): Promise<boolean> {
    return this.#sources.get(sourceId)?.files.has(normalize(path)) ?? false;
  }

  async decodeImage(
    bytes: Uint8Array,
    mimeType: string,
    _limits: RuntimeImageDecodeLimits,
  ): Promise<RuntimeDecodedImage> {
    this.decodeCalls += 1;
    if (
      mimeType === "image/png" &&
      bytes.byteLength === VALID_PNG.byteLength &&
      bytes.every((byte, index) => byte === VALID_PNG[index])
    ) {
      return { width: 1, height: 1 };
    }
    throw new Error("Fake decoder rejected invalid image bytes");
  }

  async upload(
    sourceId: string,
    path: string,
    bytes: Uint8Array,
    mimeType: string,
    options: { overwrite: boolean },
  ): Promise<RuntimeAssetUploadResult> {
    this.uploadCalls += 1;
    const source = this.#sources.get(sourceId);
    if (!source) throw new Error(`Unknown fake asset source ${sourceId}`);
    if (!source.writable) throw new Error(`Fake source ${sourceId} is read-only`);
    const normalized = normalize(path);
    if (source.files.has(normalized) && !options.overwrite)
      throw new Error(`Fake asset ${normalized} already exists`);
    source.files.set(normalized, { bytes: cloneBytes(bytes), mimeType });
    return { path: normalized };
  }

  async delete(sourceId: string, path: string): Promise<void> {
    this.#sources.get(sourceId)?.files.delete(normalize(path));
  }

  snapshotState(): FakeAssetSnapshot {
    return {
      sources: [...this.#sources.values()].map((source) => ({
        id: source.id,
        files: [...source.files.entries()].map(([path, file]) => [
          path,
          { bytes: [...file.bytes], mimeType: file.mimeType },
        ]),
      })),
      uploadCalls: this.uploadCalls,
    };
  }

  restoreState(snapshot: unknown): void {
    const state = snapshot as FakeAssetSnapshot;
    for (const saved of state.sources) {
      const source = this.#sources.get(saved.id);
      if (!source) continue;
      source.files.clear();
      for (const [path, file] of saved.files)
        source.files.set(path, { bytes: Uint8Array.from(file.bytes), mimeType: file.mimeType });
    }
    this.uploadCalls = state.uploadCalls;
  }
}

export const VALID_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0xf0,
  0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
  0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

export function createFakeAssetRuntime(): FakeFoundryAssetRuntime {
  return new FakeFoundryAssetRuntime()
    .addSource({ id: "data", writable: true })
    .addSource({ id: "public", writable: false, reason: "Foundry core assets are read-only" });
}
