import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  inspectImageBytes,
  type GeneratedImage,
  type ImageGenerationOptions,
  type ImageGenerationProvider,
} from "@foundry-mcp/protocol";

import type { Logger } from "../logger.js";
import { loadOpenAiImagesApiKey } from "../secrets/image-provider.js";
import type { SecretStorage } from "../secrets/storage.js";

export type ImageProviderErrorCode =
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_NETWORK_ERROR"
  | "PROVIDER_HTTP_ERROR"
  | "PROVIDER_INVALID_RESPONSE";

export class ImageProviderError extends Error {
  constructor(
    readonly code: ImageProviderErrorCode,
    message: string,
    readonly retryable = false,
    readonly details?: Readonly<Record<string, string | number | boolean>>,
  ) {
    super(message);
    this.name = "ImageProviderError";
  }

  toJSON(): {
    code: ImageProviderErrorCode;
    message: string;
    retryable: boolean;
    details?: Readonly<Record<string, string | number | boolean>>;
  } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32(value: number): Uint8Array {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from([...type].map((character) => character.charCodeAt(0)));
  return concatenate(
    uint32(data.byteLength),
    typeBytes,
    data,
    uint32(crc32(concatenate(typeBytes, data))),
  );
}

function deterministicPng(prompt: string): Uint8Array {
  const digest = createHash("sha256").update(prompt).digest();
  const ihdr = concatenate(uint32(1), uint32(1), Uint8Array.from([8, 6, 0, 0, 0]));
  const scanline = Uint8Array.from([0, digest[0] ?? 0, digest[1] ?? 0, digest[2] ?? 0, 255]);
  return concatenate(
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(scanline)),
    chunk("IEND", new Uint8Array()),
  );
}

export class DeterministicImageProvider implements ImageGenerationProvider {
  readonly id = "deterministic";

  async generate(prompt: string): Promise<GeneratedImage> {
    const bytes = deterministicPng(prompt);
    const inspected = inspectImageBytes(bytes, {
      expectedMimeType: "image/png",
      maxBytes: MAX_IMAGE_BYTES,
      maxPixels: MAX_IMAGE_PIXELS,
      requireDimensions: true,
    });
    if (!inspected.ok) throw new ImageProviderError("PROVIDER_INVALID_RESPONSE", inspected.reason);
    return { bytes, mimeType: inspected.value.mimeType, model: "deterministic-sha256-v1" };
  }
}

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  headers?: { get(name: string): string | null };
}

export type ImagesFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponse>;

export interface OpenAiImagesProviderOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  fetch?: ImagesFetch;
  logger?: Pick<Logger, "error">;
  maxImageBytes?: number;
  maxImagePixels?: number;
}

const OFFICIAL_OPENAI_IMAGES_ENDPOINT = "https://api.openai.com/v1/images/generations";

function validateOpenAiImagesEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new ImageProviderError(
      "PROVIDER_UNAVAILABLE",
      "OpenAI Images endpoint is not a valid URL",
    );
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname !== "api.openai.com" ||
    endpoint.port !== "" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/v1/images/generations" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new ImageProviderError(
      "PROVIDER_UNAVAILABLE",
      "OpenAI Images credentials may only be sent to the official HTTPS Images endpoint",
    );
  }
  return OFFICIAL_OPENAI_IMAGES_ENDPOINT;
}

function strictBase64(value: string, maxBytes: number): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new ImageProviderError(
      "PROVIDER_INVALID_RESPONSE",
      "OpenAI returned invalid base64 image data",
    );
  if (Math.floor((value.length * 3) / 4) > maxBytes)
    throw new ImageProviderError(
      "PROVIDER_INVALID_RESPONSE",
      `OpenAI image exceeds the ${maxBytes.toString()} byte limit`,
    );
  return Uint8Array.from(Buffer.from(value, "base64"));
}

export class OpenAiImagesProvider implements ImageGenerationProvider {
  readonly id = "openai";
  readonly #apiKey: string;
  readonly #model: string;
  readonly #endpoint: string;
  readonly #fetch: ImagesFetch;
  readonly #logger: Pick<Logger, "error"> | undefined;
  readonly #maxImageBytes: number;
  readonly #maxImagePixels: number;

  constructor(options: OpenAiImagesProviderOptions) {
    if (options.apiKey.trim().length === 0)
      throw new ImageProviderError("PROVIDER_UNAVAILABLE", "OpenAI Images is not configured");
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? "gpt-image-2";
    this.#endpoint = validateOpenAiImagesEndpoint(
      options.endpoint ?? OFFICIAL_OPENAI_IMAGES_ENDPOINT,
    );
    const fetchValue = options.fetch ?? (globalThis.fetch as unknown as ImagesFetch | undefined);
    if (!fetchValue)
      throw new ImageProviderError("PROVIDER_UNAVAILABLE", "HTTP fetch is unavailable");
    this.#fetch = fetchValue;
    this.#logger = options.logger;
    this.#maxImageBytes = options.maxImageBytes ?? MAX_IMAGE_BYTES;
    this.#maxImagePixels = options.maxImagePixels ?? MAX_IMAGE_PIXELS;
  }

  async generate(prompt: string, options: ImageGenerationOptions = {}): Promise<GeneratedImage> {
    const body = {
      model: this.#model,
      prompt,
      ...(options.size ? { size: options.size } : {}),
      ...(options.quality ? { quality: options.quality } : {}),
      ...(options.background ? { background: options.background } : {}),
      ...(options.outputFormat ? { output_format: options.outputFormat } : {}),
    };
    let response: FetchResponse;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      this.#logger?.error("OpenAI Images network request failed", {
        provider: this.id,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      throw new ImageProviderError(
        "PROVIDER_NETWORK_ERROR",
        "OpenAI Images network request failed",
        true,
      );
    }
    if (!response.ok) {
      const requestId = response.headers?.get("x-request-id") ?? undefined;
      this.#logger?.error("OpenAI Images request was rejected", {
        provider: this.id,
        status: response.status,
        ...(requestId ? { requestId } : {}),
      });
      throw new ImageProviderError(
        "PROVIDER_HTTP_ERROR",
        "OpenAI Images request was rejected",
        response.status === 429 || response.status >= 500,
        { status: response.status, ...(requestId ? { requestId } : {}) },
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ImageProviderError(
        "PROVIDER_INVALID_RESPONSE",
        "OpenAI Images returned malformed JSON",
      );
    }
    const first =
      payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
        ? (payload as { data: unknown[] }).data[0]
        : undefined;
    const encoded =
      first && typeof first === "object" ? (first as { b64_json?: unknown }).b64_json : undefined;
    if (typeof encoded !== "string" || encoded.length === 0)
      throw new ImageProviderError(
        "PROVIDER_INVALID_RESPONSE",
        "OpenAI Images response did not contain base64 image data",
      );
    const bytes = strictBase64(encoded, this.#maxImageBytes);
    const inspected = inspectImageBytes(bytes, {
      maxBytes: this.#maxImageBytes,
      maxPixels: this.#maxImagePixels,
      requireDimensions: true,
    });
    if (!inspected.ok) throw new ImageProviderError("PROVIDER_INVALID_RESPONSE", inspected.reason);
    return { bytes, mimeType: inspected.value.mimeType, model: this.#model };
  }
}

export interface ImageProviderStatus {
  id: string;
  available: boolean;
  reason?: string;
}

export class ImageProviderRegistry {
  readonly #providers = new Map<string, ImageGenerationProvider>();
  readonly #unavailable = new Map<string, string>();

  register(provider: ImageGenerationProvider): this {
    this.#providers.set(provider.id, provider);
    this.#unavailable.delete(provider.id);
    return this;
  }

  markUnavailable(id: string, reason: string): this {
    this.#providers.delete(id);
    this.#unavailable.set(id, reason);
    return this;
  }

  list(): ImageProviderStatus[] {
    return [
      ...[...this.#providers.keys()].map((id) => ({ id, available: true })),
      ...[...this.#unavailable].map(([id, reason]) => ({ id, available: false, reason })),
    ].sort((left, right) => left.id.localeCompare(right.id));
  }

  async generate(
    prompt: string,
    options: ImageGenerationOptions = {},
    providerId = "deterministic",
  ): Promise<GeneratedImage & { provider: string }> {
    const provider = this.#providers.get(providerId);
    if (!provider) {
      throw new ImageProviderError(
        "PROVIDER_UNAVAILABLE",
        this.#unavailable.get(providerId) ?? `Image provider ${providerId} is unavailable`,
      );
    }
    const image = await provider.generate(prompt, options);
    return { ...image, provider: provider.id };
  }
}

export interface CreateImageProviderRegistryOptions {
  secretStorage: SecretStorage;
  openAi?: Omit<OpenAiImagesProviderOptions, "apiKey">;
}

export async function createImageProviderRegistry(
  options: CreateImageProviderRegistryOptions,
): Promise<ImageProviderRegistry> {
  const registry = new ImageProviderRegistry().register(new DeterministicImageProvider());
  const apiKey = await loadOpenAiImagesApiKey(options.secretStorage);
  if (!apiKey)
    return registry.markUnavailable("openai", "OpenAI Images is not configured on this host");
  return registry.register(new OpenAiImagesProvider({ ...options.openAi, apiKey }));
}
