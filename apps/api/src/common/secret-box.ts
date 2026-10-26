import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Symmetric encryption for secrets we must be able to read back (TOTP seeds,
 * webhook signing secrets). AES-256-GCM with a random 96-bit IV; output is
 * `v1.<iv>.<tag>.<ciphertext>` (base64url). The key comes from
 * DATA_ENCRYPTION_KEY (any string; hashed to 32 bytes) and falls back to a key
 * derived from JWT_SECRET so dev/tests work without extra configuration.
 */
function key(): Buffer {
  const material = process.env.DATA_ENCRYPTION_KEY || `stello-data:${process.env.JWT_SECRET || "dev-secret-change-me"}`;
  if (process.env.NODE_ENV === "production" && !process.env.DATA_ENCRYPTION_KEY && !process.env.JWT_SECRET) {
    throw new Error("DATA_ENCRYPTION_KEY (or JWT_SECRET) is required in production");
  }
  return createHash("sha256").update(material).digest();
}

export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function openSecret(sealed: string): string {
  const [v, iv, tag, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || ct === undefined) throw new Error("Unrecognised sealed secret");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}
