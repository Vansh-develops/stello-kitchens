import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import type { AuthUser } from "@stello/shared";
import { InvoicesService } from "./invoices.service";
import { CurrentUser, RequirePermission } from "../common/decorators";

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

@RequirePermission("finance.manage")
@Controller("outlets/:outletId")
export class InvoicesController {
  constructor(private readonly svc: InvoicesService) {}

  @Get("invoices")
  list(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.svc.list(user, outletId, from || daysAgoStr(29), to || todayStr());
  }

  @Get("invoices/:orderId")
  detail(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("orderId") orderId: string) {
    return this.svc.detail(user, outletId, orderId);
  }

  @Post("invoices/:orderId/irn")
  generate(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("orderId") orderId: string,
    @Body() body: { buyerGstin?: string },
  ) {
    return this.svc.generateIrn(user, outletId, orderId, body?.buyerGstin?.trim() || undefined);
  }

  @Post("invoices/:orderId/cancel-irn")
  cancel(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("orderId") orderId: string,
    @Body() body: { reason?: string },
  ) {
    return this.svc.cancelIrn(user, outletId, orderId, body?.reason ?? "Cancelled by merchant");
  }

  @Get("exports/tally")
  async tally(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const f = from || daysAgoStr(29);
    const t = to || todayStr();
    const xml = await this.svc.tallyExport(user, outletId, f, t);
    return { filename: `tally-sales-${f}-to-${t}.xml`, xml };
  }
}
