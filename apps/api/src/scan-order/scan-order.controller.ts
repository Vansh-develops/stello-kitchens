import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import {
  SubmitOrderRequestSchema,
  type AuthUser,
  type SubmitOrderRequestInput,
} from "@petpooja/shared";
import { ScanOrderService } from "./scan-order.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, Public, RequirePermission } from "../common/decorators";

// Diner-facing, unauthenticated. Everything is keyed by an opaque public token,
// so there is no outlet/tenant to leak — a bad token simply 404s.
@Public()
@Controller("public/scan")
export class PublicScanController {
  constructor(private readonly svc: ScanOrderService) {}

  @Get("t/:token")
  tableMenu(@Param("token") token: string) {
    return this.svc.menuForTable(token);
  }

  @Get("kiosk/:token")
  kioskMenu(@Param("token") token: string) {
    return this.svc.menuForOutlet(token);
  }

  @Post("t/:token/order")
  submitTable(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(SubmitOrderRequestSchema)) body: SubmitOrderRequestInput,
  ) {
    return this.svc.submitFromTable(token, body);
  }

  @Post("kiosk/:token/order")
  submitKiosk(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(SubmitOrderRequestSchema)) body: SubmitOrderRequestInput,
  ) {
    return this.svc.submitFromKiosk(token, body);
  }

  @Get("request/:requestToken")
  status(@Param("requestToken") requestToken: string) {
    return this.svc.status(requestToken);
  }

  @Get("board/:token")
  board(@Param("token") token: string) {
    return this.svc.board(token);
  }
}

// Staff validation queue. Reuses orders.create — whoever can punch orders can
// validate incoming Scan & Order requests.
@RequirePermission("orders.create")
@Controller("outlets/:outletId/scan-requests")
export class ScanValidationController {
  constructor(private readonly svc: ScanOrderService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.listPending(user, outletId);
  }

  @Get("table-qrs")
  tableQrs(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.tableQrs(user, outletId);
  }

  @Get("public-token")
  publicToken(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.outletPublicToken(user, outletId);
  }

  @Post(":id/accept")
  accept(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.accept(user, id);
  }

  @Post(":id/reject")
  reject(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.reject(user, id);
  }
}
