import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import {
  CashMovementSchema,
  CloseDrawerSchema,
  OpenDrawerSchema,
  RefundSchema,
  type AuthUser,
  type CashMovementInput,
  type CloseDrawerInput,
  type OpenDrawerInput,
  type RefundInput,
} from "@stello/shared";
import { CashService } from "./cash.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, RequirePermission } from "../common/decorators";

@Controller("outlets/:outletId")
export class CashController {
  constructor(private readonly svc: CashService) {}

  // ---------- Cash drawer (cashier + owner) ----------

  @RequirePermission("orders.settle")
  @Get("cash/current")
  current(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.current(user, outletId);
  }

  @RequirePermission("orders.settle")
  @Post("cash/open")
  open(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(OpenDrawerSchema)) body: OpenDrawerInput,
  ) {
    return this.svc.openDrawer(user, outletId, body.openingFloat);
  }

  @RequirePermission("orders.settle")
  @Post("cash/close")
  close(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(CloseDrawerSchema)) body: CloseDrawerInput,
  ) {
    return this.svc.closeDrawer(user, outletId, body.countedCash);
  }

  @RequirePermission("orders.settle")
  @Post("cash/movement")
  movement(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(CashMovementSchema)) body: CashMovementInput,
  ) {
    return this.svc.addMovement(user, outletId, body);
  }

  @RequirePermission("orders.settle")
  @Get("cash/sessions")
  sessions(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.recentSessions(user, outletId);
  }

  @RequirePermission("orders.settle")
  @Get("cash/sessions/:id")
  session(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.svc.report(user, outletId, id);
  }

  // ---------- Payments ----------

  @RequirePermission("orders.settle")
  @Post("payments/:orderId/upi-qr")
  upiQr(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("orderId") orderId: string,
    @Body() body: { amount?: number },
  ) {
    return this.svc.upiQr(user, outletId, orderId, body?.amount);
  }

  @RequirePermission("orders.cancel")
  @Post("payments/:orderId/refund")
  refund(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("orderId") orderId: string,
    @Body(new ZodValidationPipe(RefundSchema)) body: RefundInput,
  ) {
    return this.svc.refund(user, outletId, orderId, body);
  }
}
