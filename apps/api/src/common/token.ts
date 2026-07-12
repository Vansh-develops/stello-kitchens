import { randomBytes, createHash } from "node:crypto";
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
export function newToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}
