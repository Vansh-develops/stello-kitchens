import { Controller, Get } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { Public } from "../common/decorators";

/**
 * Liveness probe for container healthchecks and external uptime monitoring.
 * Public (no JWT) and exempt from rate limiting so frequent polling never
 * consumes the throttle budget.
 */
@Controller("health")
export class HealthController {
  @Public()
  @SkipThrottle()
  @Get()
  check() {
    return { status: "ok", ts: new Date().toISOString() };
  }
}
