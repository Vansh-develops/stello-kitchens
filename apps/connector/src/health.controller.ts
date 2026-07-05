import { Controller, Get } from "@nestjs/common";

/** Liveness for the connector's own uptime budget / on-call. */
@Controller()
export class HealthController {
  @Get("health")
  health() {
    return { service: "connector", status: "ok", time: new Date().toISOString() };
  }
}
