import { describe, expect, it } from "vitest";

import { DeterministicImageProvider } from "../src/providers/images.js";
import {
  UrlImportError,
  importImageUrl,
  isPublicNetworkAddress,
  type UrlImportFetch,
} from "../src/assets/url-import.js";

function headers(values: Record<string, string> = {}): { get(name: string): string | null } {
  const normalized = new Map(
    Object.entries(values).map(([key, value]) => [key.toLocaleLowerCase(), value]),
  );
  return { get: (name) => normalized.get(name.toLocaleLowerCase()) ?? null };
}

function body(
  bytes: Uint8Array,
  chunkSize = bytes.byteLength,
): {
  getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> };
} {
  let offset = 0;
  return {
    getReader: () => ({
      read: () => {
        if (offset >= bytes.byteLength) return Promise.resolve({ done: true });
        const value = bytes.slice(offset, offset + chunkSize);
        offset += value.byteLength;
        return Promise.resolve({ done: false, value });
      },
      cancel: () => Promise.resolve(),
    }),
  };
}

describe("SSRF-safe image URL import", () => {
  it("classifies public and non-public IPv4/IPv6 address ranges", () => {
    expect(isPublicNetworkAddress("93.184.216.34")).toBe(true);
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.1.1",
      "::1",
      "fe80::1",
      "fd00::1",
    ])
      expect(isPublicNetworkAddress(address)).toBe(false);
  });

  it("blocks loopback, link-local, private DNS answers, and credential-bearing URLs before fetch", async () => {
    let calls = 0;
    const fetchMock: UrlImportFetch = () => {
      calls += 1;
      return Promise.reject(new Error("must not fetch"));
    };
    const cases: Array<{ url: string; resolve?: (hostname: string) => Promise<string[]> }> = [
      { url: "http://127.0.0.1/image.png" },
      { url: "http://169.254.169.254/latest/meta-data" },
      { url: "https://private.example/image.png", resolve: () => Promise.resolve(["10.1.2.3"]) },
      { url: "https://user:password@example.com/image.png" },
    ];
    for (const testCase of cases) {
      await expect(
        importImageUrl(testCase.url, {
          fetch: fetchMock,
          resolve: testCase.resolve ?? (() => Promise.resolve(["93.184.216.34"])),
        }),
      ).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
    }
    expect(calls).toBe(0);
  });

  it("revalidates redirect targets and refuses private redirect chains", async () => {
    let calls = 0;
    const fetchMock: UrlImportFetch = () => {
      calls += 1;
      return Promise.resolve({
        status: 302,
        headers: headers({ location: "http://192.168.0.1/secret.png" }),
      });
    };
    await expect(
      importImageUrl("https://example.com/start.png", {
        fetch: fetchMock,
        resolve: () => Promise.resolve(["93.184.216.34"]),
      }),
    ).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
    expect(calls).toBe(1);
  });

  it("rejects declared and streamed oversized responses before retaining the payload", async () => {
    const resolve = () => Promise.resolve(["93.184.216.34"]);
    await expect(
      importImageUrl("https://example.com/large.png", {
        maxBytes: 10,
        resolve,
        fetch: () => Promise.resolve({ status: 200, headers: headers({ "content-length": "11" }) }),
      }),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
    await expect(
      importImageUrl("https://example.com/chunked.png", {
        maxBytes: 10,
        resolve,
        fetch: () =>
          Promise.resolve({
            status: 200,
            headers: headers(),
            body: body(
              Uint8Array.from({ length: 16 }, (_, index) => index),
              8,
            ),
          }),
      }),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
  });

  it("imports a bounded valid image with MIME verification", async () => {
    const generated = await new DeterministicImageProvider().generate("url fixture");
    const imported = await importImageUrl("https://example.com/image.png", {
      resolve: () => Promise.resolve(["93.184.216.34"]),
      fetch: () =>
        Promise.resolve({
          status: 200,
          headers: headers({
            "content-type": "image/png",
            "content-length": generated.bytes.byteLength.toString(),
          }),
          body: body(generated.bytes, 7),
        }),
    });
    expect(imported).toMatchObject({
      mimeType: "image/png",
      finalUrl: "https://example.com/image.png",
    });
    expect(imported.bytes).toEqual(generated.bytes);
  });

  it("returns a structured error without echoing URL credentials", async () => {
    let error: unknown;
    try {
      await importImageUrl("https://secret-user:secret-pass@example.com/image.png", {
        fetch: () => Promise.reject(new Error("unused")),
        resolve: () => Promise.resolve(["93.184.216.34"]),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UrlImportError);
    expect(JSON.stringify(error)).not.toMatch(/secret-user|secret-pass/);
  });
});
