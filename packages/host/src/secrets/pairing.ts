import crypto from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

export function base32Decode(encoded: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of encoded.toUpperCase()) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) {
      continue;
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export interface PairingSecret {
  raw: Buffer;
  display: string;
  createdAt: string;
}

export function generatePairingSecret(): PairingSecret {
  const raw = crypto.randomBytes(32);
  return {
    raw,
    display: base32Encode(raw),
    createdAt: new Date().toISOString(),
  };
}

export interface PairingSecretStore {
  current: PairingSecret | undefined;
  previous: PairingSecret | undefined;
}

export function createPairingSecretStore(): PairingSecretStore {
  return { current: undefined, previous: undefined };
}

export function rotatePairingSecret(store: PairingSecretStore): PairingSecret {
  const next = generatePairingSecret();
  store.previous = store.current;
  store.current = next;
  return next;
}

export function validatePairingSecret(store: PairingSecretStore, candidate: Buffer): boolean {
  const current = store.current;
  if (!current || current.raw.length !== candidate.length) {
    return false;
  }
  return crypto.timingSafeEqual(current.raw, candidate);
}
