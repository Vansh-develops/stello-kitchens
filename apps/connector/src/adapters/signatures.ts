import { UnauthorizedException } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { parseOndcAuthorization, verifyOndcAuthorization } from "../outbound/ondc";

/** Express lower-cases header names; values may arrive as string or string[]. */
export type WebhookHeaders = Record<string, string | string[] | undefined>;

export function header(headers: WebhookHeaders, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Shared-secret HMAC verification used by Zomato and Swiggy. Each
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
  const configuredSecret = process.env[secretEnv];
  if (process.env.NODE_ENV === "production" && !configuredSecret) {
    throw new UnauthorizedException(`${platform} webhook verification is not configured`);
  }
  const secret = configuredSecret ?? `dev-${platform.toLowerCase()}-secret`;

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

/**
 * ONDC/Beckn seller-side signature check. Beckn signs the signing string
 * "(created) (expires) digest" — where digest is BLAKE-512 of the raw body — with
 * ed25519, and carries keyId/created/expires/signature in an `Authorization` (or
 * `X-Gateway-Authorization`) header. Verified against the caller's public key.
 *
 * GATED: production resolves each caller's key from the ONDC registry
 * (/v2.0/lookup by subscriber id + unique key id) with our own network
 * credentials, issued at ONDC onboarding. Until then a single key can be pinned
 * with ONDC_SIGNING_PUBLIC_KEY; without it, dev accepts structurally valid
 * headers and production rejects.
 */
export function verifyOndcEd25519(params: { rawBody: Buffer; headers: WebhookHeaders }): void {
  const auth = header(params.headers, "authorization") ?? header(params.headers, "x-gateway-authorization");
  if (!auth) throw new UnauthorizedException("Missing ONDC Authorization signature");
  if (!parseOndcAuthorization(auth)) throw new UnauthorizedException("Malformed ONDC signature header");

  const pubKeyB64 = process.env.ONDC_SIGNING_PUBLIC_KEY;
  if (!pubKeyB64) {
    if (process.env.NODE_ENV === "production") {
      throw new UnauthorizedException("ONDC signature verification is not configured");
    }
    return;
  }
  if (!verifyOndcAuthorization(params.rawBody, auth, pubKeyB64)) throw new UnauthorizedException("Invalid ONDC ed25519 signature");
}

/**
 * Static-token check for providers whose webhooks are not signed but let us
 * register fixed request headers (UrbanPiper's webhook config `headers`).
 */
export function verifyStaticToken(params: { platform: string; headers: WebhookHeaders; headerName: string; secretEnv: string }): void {
  const configured = process.env[params.secretEnv];
  if (process.env.NODE_ENV === "production" && !configured) {
    throw new UnauthorizedException(`${params.platform} webhook verification is not configured`);
  }
  const expected = Buffer.from(configured ?? `dev-${params.platform.toLowerCase()}-secret`);
  const provided = header(params.headers, params.headerName);
  if (!provided) throw new UnauthorizedException(`Missing ${params.headerName} webhook token`);
  const got = Buffer.from(provided);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    throw new UnauthorizedException(`Invalid ${params.platform} webhook token`);
  }
}
