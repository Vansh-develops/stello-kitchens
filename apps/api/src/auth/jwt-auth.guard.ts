import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { timingSafeEqual } from "node:crypto";
import { API_KEY_PREFIX, CSRF_HEADER, SESSION_COOKIE, type AuthUser } from "@stello/shared";
import { AuthService } from "./auth.service";
import { IS_PUBLIC_KEY, PERMISSIONS_KEY } from "../common/decorators";
import { API_KEY_ACCESS } from "../common/api-key-access";
import { enterTenant } from "../common/tenant-context";
import { parseCookies } from "../session/cookies";
import type { SessionClaims } from "../session/session.service";
import { ApiKeyService } from "../api-keys/api-key.service";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Authenticates every non-@Public route. Three credential shapes:
 *  1. `Authorization: Bearer <jwt>` — edge device, connector, scripts.
 *  2. `stello_session` httpOnly cookie — browsers. Unsafe methods must echo the
 *     session-bound CSRF token in `X-CSRF-Token` (double-submit, compared to the
 *     claim inside the signed JWT, so a planted cookie can't satisfy it).
 *  3. `Authorization: Bearer stk_…` (or `X-Api-Key`) — tenant API keys, only on
 *     routes marked @ApiKeyAccess(), scoped by the key's own permissions.
 * Session tokens are checked against the user's tokenVersion on every request.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
    private readonly apiKeys: ApiKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers["authorization"];
    const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    const headerKey = typeof request.headers["x-api-key"] === "string" ? (request.headers["x-api-key"] as string) : undefined;

    let user: AuthUser;
    const rawKey = bearer?.startsWith(API_KEY_PREFIX) ? bearer : headerKey;
    if (rawKey) {
      if (!this.reflector.getAllAndOverride<boolean>(API_KEY_ACCESS, targets)) {
        throw new ForbiddenException("API keys can't be used on this endpoint");
      }
      const principal = await this.apiKeys.authenticate(rawKey);
      if (!principal) throw new UnauthorizedException("Invalid, expired or revoked API key");
      user = principal;
    } else {
      const cookieToken = bearer ? undefined : parseCookies(request.headers["cookie"])[SESSION_COOKIE];
      const token = bearer ?? cookieToken;
      if (!token) throw new UnauthorizedException("Missing bearer token");

      let payload: SessionClaims;
      try {
        payload = await this.jwt.verifyAsync<SessionClaims>(token);
      } catch {
        throw new UnauthorizedException("Invalid or expired token");
      }
      // Step-up (MFA) tokens are not sessions.
      if (payload.purpose) throw new UnauthorizedException("Invalid or expired token");

      if (cookieToken && !SAFE_METHODS.has(String(request.method).toUpperCase())) {
        const sent = request.headers[CSRF_HEADER];
        if (!payload.csrf || typeof sent !== "string" || !sameSecret(sent, payload.csrf)) {
          throw new ForbiddenException("CSRF token missing or invalid");
        }
      }

      user = await this.auth.resolveUser(payload.sub);
      if (payload.tokenVersion !== (await this.auth.getTokenVersion(payload.sub))) {
        throw new UnauthorizedException("Session revoked");
      }
    }

    request.user = user;
    // Bind this request to the user's tenant so PrismaService scopes every
    // tenant-owned query structurally (defence beyond per-query filters).
    enterTenant(user.tenantId);

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets);
    if (required?.length) {
      const ok = required.every((p) => user.permissions.includes(p) || user.permissions.includes("*"));
      if (!ok) throw new ForbiddenException("Missing permission");
    }
    return true;
  }
}
