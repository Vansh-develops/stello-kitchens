import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";

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
    const expected = resolveConnectorKey();
    if (typeof provided !== "string" || !constantTimeEqual(provided, expected)) {
      throw new UnauthorizedException("Invalid connector key");
    }
    return true;
  }
}

/**
 * Never fall open: in production an unset CONNECTOR_KEY is fatal (a public
 * default would let anyone inject orders into any tenant). Dev keeps a fallback.
 */
function resolveConnectorKey(): string {
  const key = process.env.CONNECTOR_KEY;
  if (key && key.length > 0) return key;
  if (process.env.NODE_ENV === "production") {
    throw new Error("CONNECTOR_KEY is required in production and must not be empty");
  }
  return "dev-connector-key";
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
