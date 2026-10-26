import { Global, Module } from "@nestjs/common";
import { BillingService } from "./billing.service";
import { BillingScheduler } from "./billing.scheduler";
import { EntitlementsService } from "./entitlements.service";
import { PlanGuard } from "./plan.guard";
import { SAAS_BILLING_PROVIDER, saasBillingProviderFactory } from "./billing.provider";
import { PlatformBillingController, SubscriptionController, SubscriptionWebhookController } from "./billing.controller";

// Global so any module can put @PlanLimit / @RequireFeature on its routes
// without importing this module (the guard resolves EntitlementsService here).
@Global()
@Module({
  controllers: [SubscriptionController, SubscriptionWebhookController, PlatformBillingController],
  providers: [
    BillingService,
    BillingScheduler,
    EntitlementsService,
    PlanGuard,
    { provide: SAAS_BILLING_PROVIDER, useFactory: saasBillingProviderFactory },
  ],
  exports: [EntitlementsService, PlanGuard, BillingService],
})
export class SaasBillingModule {}
