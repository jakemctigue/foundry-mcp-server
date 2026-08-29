import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import { MAX_IMAGE_BYTES, inspectImageBytes } from "@foundry-mcp/protocol";

export type UrlImportErrorCode =
  | "INVALID_URL"
  | "SSRF_BLOCKED"
  | "TOO_MANY_REDIRECTS"
  | "TOO_LARGE"
  | "NETWORK_ERROR"
  | "INVALID_IMAGE";

export class UrlImportError extends Error {
  constructor(
    readonly code: UrlImportErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, string | number>>,
  ) {
    super(message);
    this.name = "UrlImportError";
  }
}

interface HeadersLike {
  get(name: string): string | null;
}

interface ReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel?(): Promise<void>;
}

interface UrlResponse {
  status: number;
  headers: HeadersLike;
  body?: { getReader(): ReaderLike } | null;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export type UrlImportFetch = (
  url: string,
  init: { redirect: "manual"; headers: Record<string, string>; resolvedAddresses: string[] },
) => Promise<UrlResponse>;

export type UrlAddressResolver = (hostname: string) => Promise<string[]>;

export interface ImportImageUrlOptions {
  fetch?: UrlImportFetch;
  resolve?: UrlAddressResolver;
  maxBytes?: number;
  maxRedirects?: number;
}

function blockedIpv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return true;
  const [a = 0, b = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 2) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function blockedIpv6(address: string): boolean {
  const normalized = address.toLocaleLowerCase().split("%")[0] ?? "";
  const mapped = /^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
  if (mapped) return blockedIpv4(mapped);
  return (
    normalized === "::" ||
    normalized === "::1" ||
    /^f[cd]/.test(normalized) ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  );
}

export function isPublicNetworkAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, "");
  const version = isIP(normalized);
  if (version === 4) return !blockedIpv4(normalized);
  if (version === 6) return !blockedIpv6(normalized);
  return false;
}

async function defaultResolver(hostname: string): Promise<string[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

async function validateTarget(url: URL, resolve: UrlAddressResolver): Promise<string[]> {
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new UrlImportError("INVALID_URL", "Only HTTP and HTTPS image URLs are allowed");
  if (url.username || url.password)
    throw new UrlImportError("SSRF_BLOCKED", "Credential-bearing image URLs are forbidden");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLocaleLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local"))
    throw new UrlImportError("SSRF_BLOCKED", "Local network image targets are forbidden");
  const literalVersion = isIP(hostname);
  const addresses = literalVersion ? [hostname] : await resolve(hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicNetworkAddress(address)))
    throw new UrlImportError("SSRF_BLOCKED", "Image URL resolves to a non-public network address");
  return addresses;
}

// CI uses an injected fetch; the default transport is intentionally not allowed to make real calls there.
/* v8 ignore start */
function pinnedFetch(url: string, init: Parameters<UrlImportFetch>[1]): Promise<UrlResponse> {
  const target = new URL(url);
  const firstAddress = init.resolvedAddresses[0];
  if (!firstAddress)
    return Promise.reject(new UrlImportError("SSRF_BLOCKED", "Image URL has no validated address"));
  const pinnedLookup = ((...args: unknown[]) => {
    const lookupOptions = args[1] as { all?: boolean };
    const callback = args.at(-1) as (
      error: Error | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void;
    if (lookupOptions.all) {
      callback(
        null,
        init.resolvedAddresses.map((address) => ({ address, family: isIP(address) })),
      );
      return;
    }
    callback(null, firstAddress, isIP(firstAddress));
  }) as NonNullable<RequestOptions["lookup"]>;
  return new Promise((resolve, reject) => {
    const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(
      target,
      { method: "GET", headers: init.headers, lookup: pinnedLookup },
      (response) => {
        const iterator = response[Symbol.asyncIterator]();
        resolve({
          status: response.statusCode ?? 0,
          headers: {
            get(name: string): string | null {
              const value = response.headers[name.toLocaleLowerCase()];
              return Array.isArray(value) ? value.join(", ") : (value ?? null);
            },
          },
          body: {
            getReader: () => ({
              read: async () => {
                const next = await iterator.next();
                return next.done
                  ? { done: true }
                  : { done: false, value: Uint8Array.from(next.value as Uint8Array) };
              },
              cancel: () => {
                response.destroy();
                return Promise.resolve();
              },
            }),
          },
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}
/* v8 ignore stop */

async function readBoundedBody(response: UrlResponse, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declared = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declared) && declared > maxBytes)
      throw new UrlImportError("TOO_LARGE", `Image exceeds the ${maxBytes.toString()} byte limit`);
  }
  const reader = response.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value ?? new Uint8Array();
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel?.();
        throw new UrlImportError(
          "TOO_LARGE",
          `Image exceeds the ${maxBytes.toString()} byte limit`,
        );
      }
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
  if (!response.arrayBuffer)
    throw new UrlImportError("NETWORK_ERROR", "Image response body is unavailable");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes)
    throw new UrlImportError("TOO_LARGE", `Image exceeds the ${maxBytes.toString()} byte limit`);
  return bytes;
}

export async function importImageUrl(
  input: string,
  options: ImportImageUrlOptions = {},
): Promise<{ bytes: Uint8Array; mimeType: string; finalUrl: string }> {
  let current: URL;
  try {
    current = new URL(input);
  } catch {
    throw new UrlImportError("INVALID_URL", "Image URL is malformed");
  }
  const fetchValue = options.fetch ?? pinnedFetch;
  const resolve = options.resolve ?? defaultResolver;
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
  const maxRedirects = options.maxRedirects ?? 5;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const resolvedAddresses = await validateTarget(current, resolve);
    let response: UrlResponse;
    try {
      response = await fetchValue(current.toString(), {
        redirect: "manual",
        headers: { Accept: "image/png,image/jpeg,image/gif,image/webp" },
        resolvedAddresses,
      });
    } catch {
      throw new UrlImportError("NETWORK_ERROR", "Image URL request failed");
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirectCount >= maxRedirects)
        throw new UrlImportError("TOO_MANY_REDIRECTS", "Image URL exceeded the redirect limit");
      const location = response.headers.get("location");
      if (!location) throw new UrlImportError("NETWORK_ERROR", "Image redirect omitted Location");
      try {
        current = new URL(location, current);
      } catch {
        throw new UrlImportError("INVALID_URL", "Image redirect target is malformed");
      }
      continue;
    }
    if (response.status < 200 || response.status >= 300)
      throw new UrlImportError("NETWORK_ERROR", "Image URL request was rejected", {
        status: response.status,
      });
    const bytes = await readBoundedBody(response, maxBytes);
    const declaredMime = response.headers.get("content-type") ?? undefined;
    const inspected = inspectImageBytes(bytes, {
      ...(declaredMime ? { expectedMimeType: declaredMime } : {}),
      maxBytes,
      requireDimensions: true,
    });
    if (!inspected.ok) throw new UrlImportError("INVALID_IMAGE", inspected.reason);
    return { bytes, mimeType: inspected.value.mimeType, finalUrl: current.toString() };
  }
  throw new UrlImportError("TOO_MANY_REDIRECTS", "Image URL exceeded the redirect limit");
}
