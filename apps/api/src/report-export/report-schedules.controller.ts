import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { ReportScheduleSchema, type AuthUser, type ReportScheduleInput } from "@stello/shared";
import { ReportSchedulesService } from "./report-schedules.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, RequirePermission } from "../common/decorators";

@RequirePermission("reports.view", "reports.schedule")
@Controller("outlets/:outletId/report-schedules")
export class ReportSchedulesController {
  constructor(private readonly svc: ReportSchedulesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.list(user, outletId);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Body(new ZodValidationPipe(ReportScheduleSchema)) body: ReportScheduleInput) {
    return this.svc.create(user, outletId, body);
  }

  @Patch(":id")
  update(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ReportScheduleSchema)) body: ReportScheduleInput,
  ) {
    return this.svc.update(user, outletId, id, body);
  }

  @Delete(":id")
  remove(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.svc.remove(user, outletId, id);
  }

  @HttpCode(200)
  @Post(":id/send-now")
  sendNow(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.svc.sendNow(user, outletId, id);
  }
}
