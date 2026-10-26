import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { enterTenant } from "../common/tenant-context";
import { sha256 } from "./pin";

/** The authenticated edge device for a /edge/device/* request. */
export interface EdgeDeviceContext {
  edgeDeviceId: string;
  tenantId: string;
  outletId: string;
  terminalId: string;
  seriesCode: string;
}

/** Device token wire format: `edk_<edgeDeviceId>.<secret>`. */
export function formatDeviceToken(edgeDeviceId: string, secret: string): string {
  return `edk_${edgeDeviceId}.${secret}`;
}

/**
 * Authenticates an edge terminal by its activation token (sent as
 * `Authorization: Device <token>`), independent of any user session, so a device
 * can keep syncing after a long outage without a staff member re-logging in.
 * Routes using it are `@Public()` to the JWT guard. A revoked device, a
 * deactivated terminal or a suspended tenant is refused.
 */
@Injectable()
export class EdgeDeviceGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers["authorization"];
    const token = header?.startsWith("Device ") ? header.slice(7).trim() : undefined;
    const m = token ? /^edk_([a-z0-9]+)\.([A-Za-z0-9_-]{20,})$/.exec(token) : null;
    if (!m) throw new UnauthorizedException("Missing device token");

    const device = await this.prisma.edgeDevice.findUnique({ where: { id: m[1] } });
    const presented = Buffer.from(sha256(m[2]), "hex");
    const stored = Buffer.from(device?.secretHash ?? "0".repeat(64), "hex");
    if (!device || presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
      throw new UnauthorizedException("Invalid device token");
    }
    if (device.revokedAt) throw new UnauthorizedException("Device activation was revoked");

    const [terminal, tenant] = await Promise.all([
      this.prisma.terminal.findUnique({ where: { id: device.terminalId } }),
      this.prisma.tenant.findUnique({ where: { id: device.tenantId } }),
    ]);
    if (!terminal || !terminal.isActive || terminal.outletId !== device.outletId || terminal.tenantId !== device.tenantId) {
      throw new ForbiddenException("Terminal is not active for this outlet");
    }
    if (!tenant || tenant.status === "SUSPENDED" || (tenant.status === "TRIAL" && tenant.trialEndsAt && tenant.trialEndsAt < new Date())) {
      throw new ForbiddenException("Tenant is not active");
    }

    request.edgeDevice = {
      edgeDeviceId: device.id,
      tenantId: device.tenantId,
      outletId: device.outletId,
      terminalId: device.terminalId,
      seriesCode: device.seriesCode,
    } satisfies EdgeDeviceContext;
    enterTenant(device.tenantId);
    return true;
  }
}

export const CurrentEdgeDevice = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): EdgeDeviceContext => ctx.switchToHttp().getRequest().edgeDevice,
);
