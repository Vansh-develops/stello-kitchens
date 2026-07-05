import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";

/**
 * Service-to-service auth for the connector: a shared secret in the
 * `x-connector-key` header, distinct from user JWTs. Routes using this must also
 * be marked @Public() so the global JwtAuthGuard steps aside.
 */
@Injectable()
export class ConnectorKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const provided = request.headers["x-connector-key"];
    const expected = process.env.CONNECTOR_KEY ?? "dev-connector-key";
    if (!provided || provided !== expected) {
      throw new UnauthorizedException("Invalid connector key");
    }
    return true;
  }
}
