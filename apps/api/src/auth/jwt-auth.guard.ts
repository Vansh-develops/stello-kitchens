import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { AuthService } from "./auth.service";
import { IS_PUBLIC_KEY, PERMISSIONS_KEY } from "../common/decorators";
import { enterTenant } from "../common/tenant-context";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers["authorization"];
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException("Missing bearer token");

    let payload: { sub: string };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }
    const user = await this.auth.resolveUser(payload.sub);
    request.user = user;
    // Bind this request to the user's tenant so PrismaService scopes every
    // tenant-owned query structurally (defence beyond per-query filters).
    enterTenant(user.tenantId);

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required?.length) {
      const ok = required.every((p) => user.permissions.includes(p) || user.permissions.includes("*"));
      if (!ok) throw new ForbiddenException("Missing permission");
    }
    return true;
  }
}
