import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { SESSION_MODE_HEADER, type AuthUser, type CookieSessionResponse, type LoginResponse } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { runUnscoped } from "../common/tenant-context";
import { setSessionCookies } from "./cookies";

/** JWT claims for a user session. `csrf` is present only on cookie sessions. */
export interface SessionClaims {
  sub: string;
  tenantId: string;
  tokenVersion: number;
  csrf?: string;
  /** Set on short-lived step-up tokens; the auth guard refuses any token with a purpose. */
  purpose?: string;
}

/**
 * Issues sessions in one of two shapes:
 *  - cookie mode (browsers): the client sends `X-Session-Mode: cookie`; the JWT
 *    goes into an httpOnly SameSite=Lax cookie with a session-bound CSRF token.
 *    Requiring a custom header to obtain a cookie also blocks login-CSRF (a
 *    cross-site form can't set it, and CORS gates cross-origin fetches).
 *  - bearer mode (edge device, connector, scripts): the JWT is returned in the
 *    body exactly as before.
 * Every token embeds the user's tokenVersion so revocation keeps working.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  wantsCookie(req: Request): boolean {
    return String(req.headers[SESSION_MODE_HEADER] ?? "").toLowerCase() === "cookie";
  }

  async issue(req: Request, res: Response, user: AuthUser): Promise<LoginResponse | CookieSessionResponse> {
    const { tokenVersion } = await runUnscoped(() =>
      this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { tokenVersion: true } }),
    );
    if (this.wantsCookie(req)) {
      const csrf = randomBytes(24).toString("base64url");
      const claims: SessionClaims = { sub: user.id, tenantId: user.tenantId, tokenVersion, csrf };
      setSessionCookies(res, await this.jwt.signAsync(claims), csrf);
      return { user, csrfToken: csrf };
    }
    const claims: SessionClaims = { sub: user.id, tenantId: user.tenantId, tokenVersion };
    return { accessToken: await this.jwt.signAsync(claims), user };
  }

  /** Short-lived token proving the password step passed; only good for the MFA endpoints. */
  async stepUpToken(userId: string, tenantId: string, purpose: "mfa"): Promise<string> {
    const { tokenVersion } = await runUnscoped(() =>
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { tokenVersion: true } }),
    );
    const claims: SessionClaims = { sub: userId, tenantId, tokenVersion, purpose };
    return this.jwt.signAsync(claims, { expiresIn: "5m" });
  }

  async readStepUpToken(token: string, purpose: "mfa"): Promise<SessionClaims | null> {
    try {
      const claims = await this.jwt.verifyAsync<SessionClaims>(token);
      if (claims.purpose !== purpose) return null;
      const u = await runUnscoped(() =>
        this.prisma.user.findUnique({ where: { id: claims.sub }, select: { tokenVersion: true, isActive: true } }),
      );
      if (!u || !u.isActive || u.tokenVersion !== claims.tokenVersion) return null;
      return claims;
    } catch {
      return null;
    }
  }
}
