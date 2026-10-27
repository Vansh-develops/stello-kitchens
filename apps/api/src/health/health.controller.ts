import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { Public } from "../common/decorators";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Liveness probe for container healthchecks and external uptime monitoring.
 * Public (no JWT) and exempt from rate limiting so frequent polling never
 * consumes the throttle budget.
 */
@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @SkipThrottle()
  @Get()
  check() {
    return { status: "ok", ts: new Date().toISOString() };
  }

  @Public()
  @SkipThrottle()
  @Get("ready")
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: "ready", database: "ok", ts: new Date().toISOString() };
    } catch {
      throw new ServiceUnavailableException("Database is not ready");
    }
  }
}
