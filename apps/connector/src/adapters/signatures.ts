import { UnauthorizedException } from "@nestjs/common";
import { createHash, createHmac, createPublicKey, timingSafeEqual, verify as edVerify } from "node:crypto";

/** Express lower-cases header names; values may arrive as string or string[]. */
export type WebhookHeaders = Record<string, string | string[] | undefined>;

export function header(headers: WebhookHeaders, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Shared-secret HMAC verification used by Zomato, Swiggy and UrbanPiper. Each
 * signs the exact raw request body with HMAC-SHA256 and sends the hex digest in
 * a provider-specific header (optionally "sha256="-prefixed). We recompute over
 * the raw bytes and compare in constant time. A missing signature, malformed
 * digest, or mismatch rejects the delivery with 401 before it is ever parsed.
 */
export function verifyHmacSha256(params: {
  platform: string;
  rawBody: Buffer;
  headers: WebhookHeaders;
  headerName: string;
  secretEnv: string;
}): void {
  const { platform, rawBody, headers, headerName, secretEnv } = params;
  // GATED: the production HMAC secret is issued per outlet/store at aggregator
  // onboarding and MUST be provided via the connector's environment. The dev
  // default keeps local delivery working while exercising the real code path;
  // it must never be relied on in production.
  const secret = process.env[secretEnv] ?? `dev-${platform.toLowerCase()}-secret`;

  const provided = header(headers, headerName);
  if (!provided) throw new UnauthorizedException(`Missing ${headerName} webhook signature`);
  const providedHex = provided.startsWith("sha256=") ? provided.slice(7) : provided.trim();

  const expected = createHmac("sha256", secret).update(rawBody).digest();
  let ok = false;
  try {
    const got = Buffer.from(providedHex, "hex");
    ok = got.length === expected.length && timingSafeEqual(got, expected);
  } catch {
    ok = false; // non-hex signature
  }
  if (!ok) throw new UnauthorizedException(`Invalid ${platform} webhook signature`);
}

// DER SubjectPublicKeyInfo prefix for a raw 32-byte ed25519 public key. Lets us
// build a KeyObject from the registry's base64 key without extra dependencies.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * ONDC/Beckn seller-side signature check. Beckn signs a blake2b-512 hash of the
 * request body with ed25519 and carries keyId + signature in an `Authorization`
 * (or `X-Gateway-Authorization`) signature block, verified against the caller's
 * public key resolved from the ONDC registry.
 *
 * GATED: full onboarding wires up (1) parsing keyId to identify the subscriber,
 * (2) resolving that subscriber's ed25519 public key via the ONDC registry
 * (/v2/lookup) with our own network credentials, and (3) freshness/created-expires
 * checks. Registry credentials and our signing key pair are issued at ONDC
 * certification. Until a public key is provisioned (ONDC_SIGNING_PUBLIC_KEY), we
 * reject unsigned/malformed deliveries structurally and skip the live crypto;
 * once the key is set the real ed25519 verification below becomes active.
 */
export function verifyOndcEd25519(params: { rawBody: Buffer; headers: WebhookHeaders }): void {
  const auth = header(params.headers, "authorization") ?? header(params.headers, "x-gateway-authorization");
  if (!auth) throw new UnauthorizedException("Missing ONDC Authorization signature");
  const sig = auth.match(/signature="([^"]+)"/);
  if (!/keyId="[^"]+"/.test(auth) || !sig) throw new UnauthorizedException("Malformed ONDC signature header");

  const pubKeyB64 = process.env.ONDC_SIGNING_PUBLIC_KEY;
  if (!pubKeyB64) return; // GATED: live key not yet provisioned; structural check only.

  const digest = createHash("blake2b512").update(params.rawBody).digest();
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pubKeyB64, "base64")]),
    format: "der",
    type: "spki",
  });
  let ok = false;
  try {
    ok = edVerify(null, digest, publicKey, Buffer.from(sig[1], "base64"));
  } catch {
    ok = false;
  }
  if (!ok) throw new UnauthorizedException("Invalid ONDC ed25519 signature");
}
