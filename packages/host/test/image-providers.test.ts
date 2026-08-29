import { describe, expect, it, vi } from "vitest";

import { inspectImageBytes, type ImageGenerationOptions } from "@foundry-mcp/protocol";
import type { Logger } from "../src/logger.js";
import {
  DeterministicImageProvider,
  ImageProviderError,
  OpenAiImagesProvider,
  createImageProviderRegistry,
  type ImagesFetch,
} from "../src/providers/images.js";
import { loadOpenAiImagesApiKey, saveOpenAiImagesApiKey } from "../src/secrets/image-provider.js";
import type { SecretStorage } from "../src/secrets/storage.js";

class MemorySecrets implements SecretStorage {
  readonly values = new Map<string, Buffer>();

  async save(key: string, value: Buffer): Promise<void> {
    this.values.set(key, Buffer.from(value));
  }

  async load(key: string): Promise<Buffer | undefined> {
    const value = this.values.get(key);
    return value ? Buffer.from(value) : undefined;
  }
}

function captureLogger(lines: string[]): Logger {
  const write = (message: string, fields?: Record<string, unknown>) => {
    lines.push(JSON.stringify({ message, ...fields }));
  };
  return { debug: write, info: write, warn: write, error: write };
}

describe("deterministic image provider", () => {
  it("produces a repeatable, valid one-pixel PNG from the prompt hash without network access", async () => {
    const provider = new DeterministicImageProvider();
    const first = await provider.generate("storm dragon");
    const again = await provider.generate("storm dragon");
    const different = await provider.generate("clockwork dragon");
    expect(first.bytes).toEqual(again.bytes);
    expect(first.bytes).not.toEqual(different.bytes);
    expect(first.mimeType).toBe("image/png");
    expect(inspectImageBytes(first.bytes, { requireDimensions: true })).toMatchObject({
      ok: true,
      value: { width: 1, height: 1 },
    });
  });
});

describe("OpenAI Images provider", () => {
  it("passes AbortSignal into provider fetch and stops an in-flight generation", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const fetchMock: ImagesFetch = (_url, init) => {
      receivedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new Error("provider request aborted")),
          { once: true },
        );
      });
    };
    const provider = new OpenAiImagesProvider({ apiKey: "sk-test", fetch: fetchMock });
    const generated = provider.generate("cancel me", {}, controller.signal);
    await vi.waitFor(() => expect(receivedSignal).toBe(controller.signal));
    controller.abort(new Error("caller cancelled image generation"));
    await expect(generated).rejects.toThrow("caller cancelled image generation");
  });

  it("refuses to send bearer credentials anywhere except the official HTTPS endpoint", () => {
    const fetchMock: ImagesFetch = vi.fn(() => Promise.reject(new Error("must not fetch")));
    for (const endpoint of [
      "http://api.openai.com/v1/images/generations",
      "https://evil.example/v1/images/generations",
      "https://api.openai.com/v1/images/generations?forward=evil",
      "https://user:password@api.openai.com/v1/images/generations",
      "https://api.openai.com/v1/other",
    ]) {
      expect(
        () =>
          new OpenAiImagesProvider({
            apiKey: "sk-must-not-leak",
            endpoint,
            fetch: fetchMock,
          }),
      ).toThrow(/official HTTPS Images endpoint/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses host secret storage, shapes the official Images API request, and returns base64 image bytes", async () => {
    const secrets = new MemorySecrets();
    await saveOpenAiImagesApiKey(secrets, "sk-test-provider-secret");
    expect(await loadOpenAiImagesApiKey(secrets)).toBe("sk-test-provider-secret");
    const deterministic = await new DeterministicImageProvider().generate("mock response");
    const requests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const fetchMock: ImagesFetch = (url, init) => {
      requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: [{ b64_json: Buffer.from(deterministic.bytes).toString("base64") }],
          }),
        headers: { get: () => "request-safe-id" },
      });
    };
    const registry = await createImageProviderRegistry({
      secretStorage: secrets,
      openAi: { fetch: fetchMock, model: "gpt-image-2" },
    });
    const generated = await registry.generate(
      "A token portrait",
      {
        size: "1024x1024",
        quality: "high",
        background: "transparent",
        outputFormat: "png",
      },
      "openai",
    );
    expect(generated).toMatchObject({
      provider: "openai",
      model: "gpt-image-2",
      mimeType: "image/png",
    });
    expect(requests).toEqual([
      {
        url: "https://api.openai.com/v1/images/generations",
        headers: {
          Authorization: "Bearer sk-test-provider-secret",
          "Content-Type": "application/json",
        },
        body: {
          model: "gpt-image-2",
          prompt: "A token portrait",
          size: "1024x1024",
          quality: "high",
          background: "transparent",
          output_format: "png",
        },
      },
    ]);
  });

  it("keeps OpenAI opt-in, defaults explicitly to deterministic, and never silently falls back", async () => {
    const registry = await createImageProviderRegistry({ secretStorage: new MemorySecrets() });
    expect(registry.list()).toEqual([
      { id: "deterministic", available: true },
      { id: "openai", available: false, reason: "OpenAI Images is not configured on this host" },
    ]);
    expect(await registry.generate("local default")).toMatchObject({ provider: "deterministic" });
    await expect(registry.generate("must be OpenAI", {}, "openai")).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it("returns structured redacted network/HTTP errors with no provider fallback", async () => {
    const secret = "sk-never-log-this-secret";
    const lines: string[] = [];
    const throwingFetch: ImagesFetch = () =>
      Promise.reject(new Error(`socket failed while using ${secret}`));
    const provider = new OpenAiImagesProvider({
      apiKey: secret,
      fetch: throwingFetch,
      logger: captureLogger(lines),
    });
    let failure: unknown;
    try {
      await provider.generate("network failure");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ImageProviderError);
    expect((failure as ImageProviderError).toJSON()).toMatchObject({
      code: "PROVIDER_NETWORK_ERROR",
      retryable: true,
    });
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(lines.join("\n")).not.toContain(secret);

    const rejected = new OpenAiImagesProvider({
      apiKey: secret,
      fetch: () =>
        Promise.resolve({
          ok: false,
          status: 429,
          json: () => Promise.resolve({ error: { message: secret } }),
          headers: { get: () => "safe-request-id" },
        }),
      logger: captureLogger(lines),
    });
    await expect(rejected.generate("rate limited")).rejects.toMatchObject({
      code: "PROVIDER_HTTP_ERROR",
      retryable: true,
      details: { status: 429, requestId: "safe-request-id" },
    });
    expect(lines.join("\n")).not.toContain(secret);
  });

  it("rejects malformed or non-image base64 provider responses", async () => {
    const options: ImageGenerationOptions = {};
    const provider = new OpenAiImagesProvider({
      apiKey: "sk-test-value",
      fetch: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: [{ b64_json: "bm90LWltYWdl" }] }),
        }),
    });
    await expect(provider.generate("bad bytes", options)).rejects.toMatchObject({
      code: "PROVIDER_INVALID_RESPONSE",
    });
  });
});
