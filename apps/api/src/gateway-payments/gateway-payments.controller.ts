import { Body, Controller, Get, Headers, HttpCode, Param, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import type { Request } from "express";
import { GatewayCollectSchema, type AuthUser, type GatewayCollectInput } from "@stello/shared";
import { GatewayPaymentsService } from "./gateway-payments.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, Public, RequirePermission } from "../common/decorators";

@Controller("outlets/:outletId")
export class GatewayPaymentsController {
  constructor(private readonly svc: GatewayPaymentsService) {}

  /** Start a Razorpay collection (dynamic UPI QR, or payment link) for a bill. */
  @RequirePermission("orders.settle")
  @Post("payments/:orderId/collect")
  collect(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("orderId") orderId: string,
    @Body(new ZodValidationPipe(GatewayCollectSchema)) body: GatewayCollectInput,
  ) {
    return this.svc.createCollect(user, outletId, orderId, body);
  }

  @RequirePermission("orders.settle")
  @Get("payments/:orderId/collections")
  collections(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("orderId") orderId: string) {
    return this.svc.listForOrder(user, outletId, orderId);
  }

  @RequirePermission("orders.settle")
  @Get("payment-collections/:id")
  get(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.svc.getCollect(user, outletId, id);
  }

  @RequirePermission("orders.settle")
  @Post("payment-collections/:id/cancel")
  cancel(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.svc.cancelCollect(user, outletId, id);
  }

  @RequirePermission("orders.settle")
  @Post("payment-collections/:id/simulate-paid")
  simulate(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.svc.simulatePaid(user, outletId, id);
  }

  @RequirePermission("orders.cancel")
  @Get("refunds/unresolved")
  unresolved(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.unresolvedRefunds(user, outletId);
  }

  @RequirePermission("orders.cancel")
  @Post("refunds/:id/reconcile")
  reconcile(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.svc.reconcileRefundNow(user, outletId, id);
  }
}

/** Razorpay → us. Authenticated by the X-Razorpay-Signature HMAC over the raw body. */
@Public()
@SkipThrottle()
@Controller("webhooks")
export class RazorpayWebhookController {
  constructor(private readonly svc: GatewayPaymentsService) {}

  @Post("razorpay")
  @HttpCode(200)
  razorpay(
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-razorpay-signature") signature: string | undefined,
    @Headers("x-razorpay-event-id") eventId: string | undefined,
  ) {
    return this.svc.handleRazorpayWebhook(req.rawBody, signature, eventId);
  }
}
