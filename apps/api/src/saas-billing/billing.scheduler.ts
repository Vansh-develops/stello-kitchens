import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { BillingService } from "./billing.service";

const HOUR = 60 * 60 * 1000;

/**
 * Runs the subscription lifecycle sweep hourly (trial expiry, grace lapse, mock
 * renewals). Disabled under tests and with SAAS_BILLING_CYCLE_DISABLED=1; platform
 * admins can also trigger it via POST /platform/subscriptions/run-cycle.
 */
@Injectable()
export class BillingScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("SaasBillingCycle");
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly billing: BillingService) {}

  onModuleInit() {
    if (process.env.VITEST || process.env.NODE_ENV === "test" || process.env.SAAS_BILLING_CYCLE_DISABLED === "1") return;
    this.timer = setInterval(() => {
      this.billing
        .runCycle()
        .then((r) => this.logger.log(`cycle: ${JSON.stringify(r)}`))
        .catch((e) => this.logger.warn(`cycle failed: ${(e as Error).message}`));
    }, HOUR);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
