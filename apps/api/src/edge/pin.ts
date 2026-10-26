import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Offline staff PINs. The edge device must verify a PIN with the WAN down, so the
// hash travels to the device in the change feed. A 4–6 digit PIN has a tiny key
// space, so the hash is deliberately expensive (scrypt, N=2^14) and salted per PIN;
// the device additionally locks a staff account out after repeated failures.
// Format (mirrored by apps/edge/sidecar/pin.js — keep in sync):
//   scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64url");
  const actual = scryptSync(pin, Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Device bearer secrets are high-entropy, so a fast hash is sufficient. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function newDeviceSecret(): string {
  return randomBytes(32).toString("base64url");
}
