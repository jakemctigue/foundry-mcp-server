import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BridgeAuthenticator,
  findInProcessBridgeAuthKey,
  isBridgeRequestAuthorized,
  loadExistingBridgeAuthKey,
  loadOrCreateBridgeAuthKey,
  registerInProcessBridgeAuthKey,
  unregisterInProcessBridgeAuthKey,
} from "../src/bridge/bridge-auth.js";
import { createLogger } from "../src/logger.js";

const AUTH_KEY = Buffer.alloc(32, 0x51);

describe("bridge defense-in-depth authorization", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { acl: true, hmac: true, expected: true },
    { acl: true, hmac: false, expected: false },
    { acl: false, hmac: true, expected: false },
    { acl: false, hmac: false, expected: false },
  ])(
    "requires both ACL/token=$acl and HMAC=$hmac (authorized=$expected)",
    ({ acl, hmac, expected }) => {
      expect(isBridgeRequestAuthorized(acl, hmac)).toBe(expected);
    },
  );

  it("authenticates an untampered message", () => {
    const signer = new BridgeAuthenticator(AUTH_KEY);
    const verifier = new BridgeAuthenticator(AUTH_KEY);
    const envelope = signer.sign({ method: "connections.list" });
    expect(verifier.verify(envelope)).toEqual({
      ok: true,
      message: { method: "connections.list" },
    });
  });

  it("fails closed for a wrong key", () => {
    const signer = new BridgeAuthenticator(AUTH_KEY);
    const verifier = new BridgeAuthenticator(Buffer.alloc(32, 0x52));
    expect(verifier.verify(signer.sign({ method: "connections.list" })).ok).toBe(false);
  });

  it("fails closed for a replayed authenticated frame", () => {
    const signer = new BridgeAuthenticator(AUTH_KEY);
    const verifier = new BridgeAuthenticator(AUTH_KEY);
    const envelope = signer.sign({ method: "connections.list" });
    expect(verifier.verify(envelope).ok).toBe(true);
    expect(verifier.verify(envelope)).toMatchObject({
      ok: false,
      reason: "replayed authenticated bridge envelope",
    });
  });

  it("fails closed if the payload is modified after signing", () => {
    const signer = new BridgeAuthenticator(AUTH_KEY);
    const verifier = new BridgeAuthenticator(AUTH_KEY);
    const envelope = signer.sign({ method: "connections.list" });
    const changed = {
      ...envelope,
      payload: Buffer.from(JSON.stringify({ method: "documents.delete" }), "utf8").toString(
        "base64url",
      ),
    };
    expect(verifier.verify(changed).ok).toBe(false);
  });

  it.each([
    null,
    {},
    { version: 2, nonce: "a", payload: "a", mac: "a" },
    { version: 1, payload: "a", mac: "a" },
    { version: 1, nonce: "a", mac: "a" },
    { version: 1, nonce: "a", payload: "a" },
  ])("rejects malformed envelopes without throwing", (value) => {
    expect(new BridgeAuthenticator(AUTH_KEY).verify(value)).toMatchObject({ ok: false });
  });

  it.each([
    { field: "nonce", value: "not+base64url" },
    { field: "nonce", value: "YQ" },
    { field: "payload", value: "not+base64url" },
    { field: "mac", value: "not+base64url" },
  ])("rejects invalid $field encoding", ({ field, value }) => {
    const envelope = new BridgeAuthenticator(AUTH_KEY).sign({ ok: true });
    const changed = { ...envelope, [field]: value };
    expect(new BridgeAuthenticator(AUTH_KEY).verify(changed)).toMatchObject({ ok: false });
  });

  it("requires an exact 256-bit key", () => {
    expect(() => new BridgeAuthenticator(Buffer.alloc(31))).toThrow(/exactly 32 bytes/);
  });

  it("rejects non-serializable and oversized outgoing messages", () => {
    const signer = new BridgeAuthenticator(AUTH_KEY);
    expect(() => signer.sign(undefined)).toThrow(/not JSON serializable/);
    expect(() => signer.sign("x".repeat(16 * 1024 * 1024))).toThrow(/payload limit/);
  });

  it("registers defensive copies in the in-process test/integration keyring", () => {
    const key = Buffer.from(AUTH_KEY);
    registerInProcessBridgeAuthKey("test-pipe", key);
    key.fill(0);
    const found = findInProcessBridgeAuthKey("test-pipe");
    expect(found?.equals(AUTH_KEY)).toBe(true);
    found?.fill(0);
    expect(findInProcessBridgeAuthKey("test-pipe")?.equals(AUTH_KEY)).toBe(true);
    unregisterInProcessBridgeAuthKey("test-pipe");
    expect(findInProcessBridgeAuthKey("test-pipe")).toBeUndefined();
  });

  it("creates, persists, and reloads the per-user bridge key", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fmcp-bridge-auth-"));
    temporaryDirectories.push(directory);
    const logger = createLogger({ sinks: [{ write: () => {} }], level: "error" });
    expect(await loadExistingBridgeAuthKey(directory)).toBeUndefined();
    const created = await loadOrCreateBridgeAuthKey(directory, logger);
    const loaded = await loadOrCreateBridgeAuthKey(directory, logger);
    const clientLoaded = await loadExistingBridgeAuthKey(directory);
    expect(created.length).toBe(32);
    expect(loaded.equals(created)).toBe(true);
    expect(clientLoaded?.equals(created)).toBe(true);
  });

  it("rejects authenticated payloads that are too large or not JSON", () => {
    const oversizedPayload = Buffer.alloc(16 * 1024 * 1024 + 1, 0x61);
    expect(
      new BridgeAuthenticator(AUTH_KEY).verify({
        version: 1,
        nonce: Buffer.alloc(16, 1).toString("base64url"),
        payload: oversizedPayload.toString("base64url"),
        mac: Buffer.alloc(32, 1).toString("base64url"),
      }),
    ).toMatchObject({ ok: false });

    const nonce = Buffer.alloc(16, 2);
    const invalidJson = Buffer.from("{", "utf8");
    const mac = crypto
      .createHmac("sha256", AUTH_KEY)
      .update(Buffer.from("foundry-mcp-bridge-v1\0", "utf8"))
      .update(nonce)
      .update(invalidJson)
      .digest();
    expect(
      new BridgeAuthenticator(AUTH_KEY).verify({
        version: 1,
        nonce: nonce.toString("base64url"),
        payload: invalidJson.toString("base64url"),
        mac: mac.toString("base64url"),
      }),
    ).toMatchObject({
      ok: false,
      reason: "authenticated bridge payload is not valid JSON",
    });
  });

  it("fails closed after the bounded per-connection frame budget", () => {
    const signer = new BridgeAuthenticator(AUTH_KEY);
    const verifier = new BridgeAuthenticator(AUTH_KEY);
    for (let index = 0; index < 4_096; index += 1) {
      expect(verifier.verify(signer.sign(index)).ok).toBe(true);
    }
    expect(verifier.verify(signer.sign("one-too-many"))).toMatchObject({
      ok: false,
      reason: "authenticated bridge connection frame budget exhausted",
    });
  });
});
