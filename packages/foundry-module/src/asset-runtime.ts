import type { AssetSourceCapability } from "@foundry-mcp/protocol";

export interface RuntimeAssetEntry {
  path: string;
  kind: "file" | "directory";
  size?: number;
  mimeType?: string;
}

export interface RuntimeAssetBrowseResult {
  entries: RuntimeAssetEntry[];
}

export interface RuntimeAssetUploadResult {
  path: string;
}

export interface FoundryAssetRuntimeAdapter {
  isOnline(): boolean;
  listSources(): Promise<AssetSourceCapability[]>;
  browse(sourceId: string, path: string, extensions?: string[]): Promise<RuntimeAssetBrowseResult>;
  exists(sourceId: string, path: string): Promise<boolean>;
  upload(
    sourceId: string,
    path: string,
    bytes: Uint8Array,
    mimeType: string,
    options: { overwrite: boolean },
  ): Promise<RuntimeAssetUploadResult>;
  delete?(sourceId: string, path: string): Promise<void>;
  snapshotState?(): unknown | Promise<unknown>;
  restoreState?(snapshot: unknown): void | Promise<void>;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? (value as UnknownRecord)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function values(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value instanceof Map || value instanceof Set) return [...value.values()];
  return Object.values(record(value));
}

function filePickerConstructor(globalValue: UnknownRecord): UnknownRecord {
  const foundry = record(globalValue.foundry);
  const applications = record(foundry.applications);
  const apps = record(applications.apps);
  const candidate = apps.FilePicker ?? globalValue.FilePicker;
  if (typeof candidate !== "function") throw new Error("Foundry FilePicker is unavailable");
  return candidate as unknown as UnknownRecord;
}

function pickerSourceIds(FilePicker: UnknownRecord): string[] {
  const ids = new Set<string>();
  try {
    const instance = Reflect.construct(FilePicker as unknown as new () => object, [
      { type: "image" },
    ]);
    for (const id of Object.keys(record(record(instance).sources))) ids.add(id);
  } catch {
    // Static browse remains usable on versions where constructing a picker requires rendered UI.
  }
  ids.add("data");
  ids.add("public");
  if (values(FilePicker.S3_BUCKETS).length > 0) ids.add("s3");
  return [...ids];
}

function canUpload(globalValue: UnknownRecord): boolean {
  const user = record(record(globalValue.game).user);
  if (user.isGM === true) return true;
  const can = user.can;
  if (typeof can !== "function") return false;
  try {
    return can.call(user, "FILES_UPLOAD") === true;
  } catch {
    return false;
  }
}

function pathFromPickerEntry(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const entry = record(value);
  return stringValue(entry.path) ?? stringValue(entry.url) ?? stringValue(entry.name);
}

export interface BrowserFoundryAssetRuntimeOptions {
  global?: unknown;
  sourceCapabilities?: Record<string, { writable: boolean; reason?: string }>;
}

/** Uses only Foundry's public FilePicker surface; it never reads the browser host filesystem. */
export class BrowserFoundryAssetRuntime implements FoundryAssetRuntimeAdapter {
  readonly #global: UnknownRecord;
  readonly #configuredCapabilities: Record<string, { writable: boolean; reason?: string }>;

  constructor(options: BrowserFoundryAssetRuntimeOptions = {}) {
    this.#global = record(options.global ?? globalThis);
    this.#configuredCapabilities = options.sourceCapabilities ?? {};
  }

  isOnline(): boolean {
    return record(this.#global.game).ready !== false;
  }

  async listSources(): Promise<AssetSourceCapability[]> {
    const FilePicker = filePickerConstructor(this.#global);
    const uploadAllowed = canUpload(this.#global);
    return pickerSourceIds(FilePicker).map((id) => {
      const configured = this.#configuredCapabilities[id];
      if (configured) return { id, ...configured };
      if (id === "public") {
        return {
          id,
          writable: false,
          reason: "Foundry core public assets are read-only",
        };
      }
      return uploadAllowed
        ? { id, writable: true }
        : { id, writable: false, reason: "The connected Foundry user cannot upload files" };
    });
  }

  async browse(
    sourceId: string,
    path: string,
    extensions?: string[],
  ): Promise<RuntimeAssetBrowseResult> {
    const FilePicker = filePickerConstructor(this.#global);
    const browse = FilePicker.browse;
    if (typeof browse !== "function") throw new Error("Foundry FilePicker.browse() is unavailable");
    const raw = record(
      await browse.call(FilePicker, sourceId, path, extensions ? { extensions } : {}),
    );
    const entries: RuntimeAssetEntry[] = [];
    for (const directory of values(raw.dirs ?? raw.directories)) {
      const entryPath = pathFromPickerEntry(directory);
      if (entryPath) entries.push({ path: entryPath, kind: "directory" });
    }
    for (const file of values(raw.files)) {
      const entryPath = pathFromPickerEntry(file);
      if (!entryPath) continue;
      const metadata = record(file);
      const size = typeof metadata.size === "number" ? metadata.size : undefined;
      const mimeType = stringValue(metadata.mimeType) ?? stringValue(metadata.type);
      entries.push({
        path: entryPath,
        kind: "file",
        ...(size !== undefined ? { size } : {}),
        ...(mimeType ? { mimeType } : {}),
      });
    }
    return { entries };
  }

  async exists(sourceId: string, path: string): Promise<boolean> {
    const slash = path.lastIndexOf("/");
    const directory = slash < 0 ? "" : path.slice(0, slash);
    const result = await this.browse(sourceId, directory);
    return result.entries.some((entry) => entry.kind === "file" && entry.path === path);
  }

  async upload(
    sourceId: string,
    path: string,
    bytes: Uint8Array,
    mimeType: string,
    options: { overwrite: boolean },
  ): Promise<RuntimeAssetUploadResult> {
    const FilePicker = filePickerConstructor(this.#global);
    const upload = FilePicker.upload;
    if (typeof upload !== "function") throw new Error("Foundry FilePicker.upload() is unavailable");
    const slash = path.lastIndexOf("/");
    const directory = slash < 0 ? "" : path.slice(0, slash);
    const name = slash < 0 ? path : path.slice(slash + 1);
    const FileValue = this.#global.File;
    if (typeof FileValue !== "function")
      throw new Error("The browser File constructor is unavailable");
    const file = Reflect.construct(FileValue as unknown as new () => object, [
      [bytes],
      name,
      { type: mimeType },
    ]);
    const response = record(
      await upload.call(
        FilePicker,
        sourceId,
        directory,
        file,
        { overwrite: options.overwrite },
        { notify: false },
      ),
    );
    return { path: stringValue(response.path) ?? path };
  }
}
