import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  createPairingSecretStore,
  generatePairingSecret,
  rotatePairingSecret,
  validatePairingSecret,
} from "../src/secrets/pairing.js";

describe("pairing secret", () => {
  it("generates 256-bit (32 byte) secrets", () => {
    const secret = generatePairingSecret();
    expect(secret.raw.length).toBe(32);
  });

  it("base32-encodes and round-trips to the original 32 bytes", () => {
    const secret = generatePairingSecret();
    const decoded = base32Decode(secret.display);
    expect(decoded.equals(secret.raw)).toBe(true);
    expect(decoded.length).toBe(32);
  });

  it("base32 round-trips arbitrary buffers", () => {
    const buf = Buffer.from("hello world, this is a test payload!");
    const encoded = base32Encode(buf);
    const decoded = base32Decode(encoded);
    expect(decoded.equals(buf)).toBe(true);
  });

  it("validates the current secret", () => {
    const store = createPairingSecretStore();
    const secret = rotatePairingSecret(store);
    expect(validatePairingSecret(store, secret.raw)).toBe(true);
  });

  it("invalidates the previous secret after rotation", () => {
    const store = createPairingSecretStore();
    const oldSecret = rotatePairingSecret(store);
    rotatePairingSecret(store);
    expect(validatePairingSecret(store, oldSecret.raw)).toBe(false);
  });
});
