import { randomBytes } from "node:crypto";
/** Opaque token for Scan & Order QR URLs. Matches the scheme used in the seed. */
export const publicToken = (): string => randomBytes(9).toString("base64url");
