import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>` (Stripe-style). */
export function signWebhook(secret: string, body: string, timestampSec: number): string {
  const mac = createHmac("sha256", secret).update(`${timestampSec}.${body}`).digest("hex");
  return `t=${timestampSec},v1=${mac}`;
}

/** Receiver-side check (documented in docs/PUBLIC-API.md); also used by tests. */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1 || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = Buffer.from(signWebhook(secret, body, t).split("v1=")[1]);
  const given = Buffer.from(parts.v1);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Delay before retry N (1-based count of failed attempts so far). */
export const RETRY_BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];
export const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;

export function nextRetryDelay(failedAttempts: number): number | null {
  if (failedAttempts >= MAX_ATTEMPTS) return null;
  const base = RETRY_BACKOFF_MS[Math.min(failedAttempts, RETRY_BACKOFF_MS.length) - 1];
  // ±10% jitter so a recovering receiver isn't hit by a synchronized wave.
  return Math.round(base * (0.9 + Math.random() * 0.2));
}

function isPrivateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Private/loopback targets are refused in production unless explicitly allowed (SSRF guard). */
function privateTargetsAllowed(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.WEBHOOK_ALLOW_PRIVATE === "true";
}

/** Static checks at subscription time. Returns an error message or null. */
export function checkWebhookUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Invalid URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "URL must be http(s)";
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") return "Webhook URLs must use https";
  if (url.username || url.password) return "Credentials in the URL are not allowed";
  if (!privateTargetsAllowed()) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || (isIP(host) && isPrivateAddress(host))) return "Private network addresses are not allowed";
  }
  return null;
}

/** Resolve-time check right before sending (defeats DNS names pointing inside). */
export async function assertPublicTarget(raw: string): Promise<void> {
  if (privateTargetsAllowed()) return;
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error("Target resolves to a private address");
}
