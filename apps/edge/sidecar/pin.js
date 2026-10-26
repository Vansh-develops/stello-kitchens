"use strict";
// Offline staff PIN verification. Mirrors apps/api/src/edge/pin.ts — the cloud
// hashes a PIN once and ships the hash to the device in the change feed:
//   scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>
const crypto = require("node:crypto");

function scrypt(pin, salt, keylen, opts) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(pin, salt, keylen, { ...opts, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** Async so a PIN check (~50 ms of scrypt) never stalls the sidecar's event loop. */
async function verifyPin(pin, stored) {
  if (typeof pin !== "string" || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64url");
  const actual = await scrypt(pin, Buffer.from(salt, "base64url"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Same format as the API; used by tests and local tooling. */
async function hashPin(pin, salt = crypto.randomBytes(16)) {
  const key = await scrypt(pin, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");

module.exports = { verifyPin, hashPin, sha256 };
