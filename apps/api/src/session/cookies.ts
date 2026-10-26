import type { CookieOptions, Response } from "express";
import { CSRF_COOKIE, SESSION_COOKIE } from "@stello/shared";

/** Minimal RFC 6265 cookie-header parser (no dependency on cookie-parser). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // matches the JWT expiry

/** Secure unless explicitly disabled; always Secure in production. */
function secure(): boolean {
  if (process.env.NODE_ENV === "production") return true;
  return process.env.COOKIE_SECURE === "true";
}

function base(): CookieOptions {
  return {
    sameSite: "lax",
    secure: secure(),
    path: "/",
    ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
  };
}

export function setSessionCookies(res: Response, jwt: string, csrf: string): void {
  // The session JWT is httpOnly — page scripts (and any XSS) can't read it.
  res.cookie(SESSION_COOKIE, jwt, { ...base(), httpOnly: true, maxAge: SESSION_TTL_MS });
  // The CSRF token is deliberately readable so the SPA can echo it in a header
  // (double-submit). It is bound to the session: the JWT carries the same value.
  res.cookie(CSRF_COOKIE, csrf, { ...base(), httpOnly: false, maxAge: SESSION_TTL_MS });
}

export function clearSessionCookies(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { ...base(), httpOnly: true });
  res.clearCookie(CSRF_COOKIE, { ...base(), httpOnly: false });
}
