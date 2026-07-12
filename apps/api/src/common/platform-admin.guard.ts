import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";

/**
 * Allows only platform super-admins. Runs after the global JwtAuthGuard, which
 * has already populated request.user (including isPlatformAdmin) from the DB.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest().user;
    if (!user?.isPlatformAdmin) throw new ForbiddenException("Platform admin only");
    return true;
  }
}
