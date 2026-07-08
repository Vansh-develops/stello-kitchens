import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { CustomReportSchema, type AuthUser, type CustomReportInput } from "@stello/shared";
import { ReportsService } from "./reports.service";
import { ZodValidationPipe } from "../common/zod.pipe";
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
const from = (q?: string) => q || daysAgoStr(29);
const to = (q?: string) => q || todayStr();

@RequirePermission("reports.view")
@Controller("outlets/:outletId/reports")
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  @Get("overview")
  overview(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Query("from") f?: string,
    @Query("to") t?: string,
  ) {
    return this.svc.overview(user, outletId, from(f), to(t));
  }

  @Get("breakdown")
  breakdown(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Query("from") f?: string,
    @Query("to") t?: string,
  ) {
    return this.svc.breakdown(user, outletId, from(f), to(t));
  }

  @Get("day-end")
  dayEnd(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Query("date") date?: string) {
    return this.svc.dayEnd(user, outletId, date || todayStr());
  }

  @Get("fraud")
  fraud(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Query("from") f?: string,
    @Query("to") t?: string,
  ) {
    return this.svc.fraud(user, outletId, from(f), to(t));
  }

  @Post("custom")
  custom(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(CustomReportSchema)) body: CustomReportInput,
  ) {
    return this.svc.custom(user, outletId, body);
  }
}

@RequirePermission("reports.view")
@Controller("reports")
export class OwnerReportsController {
  constructor(private readonly svc: ReportsService) {}

  @Get("outlets")
  outlets(@CurrentUser() user: AuthUser, @Query("from") f?: string, @Query("to") t?: string) {
    return this.svc.outletKpis(user, from(f), to(t));
  }
}
