import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import {
  PlatformSubscriptionActionSchema,
  SubscribeSchema,
  UpdatePlanSchema,
  type AuthUser,
  type PlatformSubscriptionActionInput,
  type SubscribeInput,
  type UpdatePlanInput,
} from "@stello/shared";
import { BillingService } from "./billing.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, Public, RequirePermission } from "../common/decorators";
import { PlatformAdminGuard } from "../common/platform-admin.guard";

// Tenant-facing: the restaurant's own Stello subscription.
@RequirePermission("billing.manage")
@Controller("subscription")
export class SubscriptionController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.billing.getSubscription(user.tenantId);
  }

  @Post("subscribe")
  subscribe(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(SubscribeSchema)) body: SubscribeInput) {
    return this.billing.subscribe(user, body);
  }

  @Post("cancel")
  cancel(@CurrentUser() user: AuthUser) {
    return this.billing.cancel(user);
  }

  @Get("invoices/:id")
  invoice(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.billing.getInvoice(user.tenantId, id);
  }

  @Post("invoices/:id/pay")
  pay(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.billing.payInvoice(user, id);
  }
}

// Provider webhooks (Razorpay Subscriptions). Authenticated by HMAC signature.
@Public()
@Controller("public/subscription")
export class SubscriptionWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Post("webhook/razorpay")
  @HttpCode(200)
  webhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Body() body: unknown,
    @Headers("x-razorpay-signature") signature?: string,
    @Headers("x-razorpay-event-id") eventId?: string,
  ) {
    const raw = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(body ?? {});
    return this.billing.handleWebhook(raw, signature, eventId, body);
  }
}

// Platform super-admin view across all tenants.
@Controller("platform")
@UseGuards(PlatformAdminGuard)
export class PlatformBillingController {
  constructor(private readonly billing: BillingService) {}

  @Get("subscriptions")
  list() {
    return this.billing.platformList();
  }

  @Post("subscriptions/run-cycle")
  runCycle() {
    return this.billing.runCycle();
  }

  @Post("subscriptions/:tenantId/action")
  action(
    @Param("tenantId") tenantId: string,
    @Body(new ZodValidationPipe(PlatformSubscriptionActionSchema)) body: PlatformSubscriptionActionInput,
  ) {
    return this.billing.platformAction(tenantId, body);
  }

  @Get("plans")
  plans() {
    return this.billing.listPlans();
  }

  @Patch("plans/:code")
  updatePlan(@Param("code") code: string, @Body(new ZodValidationPipe(UpdatePlanSchema)) body: UpdatePlanInput) {
    return this.billing.updatePlan(code, body);
  }
}
