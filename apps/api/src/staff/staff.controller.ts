import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  AttendanceCorrectionSchema,
  ClockActionSchema,
  CreatePayrollRunSchema,
  DecisionSchema,
  LeaveBalanceSchema,
  LeaveRequestSchema,
  PayrollConfigSchema,
  RosterAssignSchema,
  SalaryAdvanceSchema,
  SetPinSchema,
  ShiftTemplateSchema,
  StaffInputSchema,
  SwapRequestSchema,
  UpdatePayslipSchema,
  UpdateStaffSchema,
  addDays,
  istDateOf,
  type AttendanceCorrectionInput,
  type AuthUser,
  type ClockActionInput,
  type CreatePayrollRunInput,
  type DecisionInput,
  type LeaveBalanceInput,
  type LeaveRequestInput,
  type PayrollConfig,
  type RosterAssignInput,
  type SalaryAdvanceInput,
  type SetPinInput,
  type ShiftTemplateInput,
  type StaffInput,
  type SwapRequestInput,
  type UpdatePayslipInput,
  type UpdateStaffInput,
} from "@stello/shared";
import { StaffService } from "./staff.service";
import { RosterService } from "./roster.service";
import { PayrollService } from "./payroll.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, RequirePermission } from "../common/decorators";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const date = (v: string | undefined, fallback: string) => {
  const d = v || fallback;
  if (!DATE_RE.test(d)) throw new BadRequestException("Dates must be YYYY-MM-DD");
  return d;
};

@Controller("outlets/:outletId")
export class StaffController {
  constructor(
    private readonly staff: StaffService,
    private readonly roster: RosterService,
    private readonly payroll: PayrollService,
  ) {}

  // ---------- Profiles ----------

  @RequirePermission("staff.manage")
  @Get("staff")
  list(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.staff.list(user, outletId);
  }

  @RequirePermission("staff.manage")
  @Get("staff/linkable-users")
  linkable(@CurrentUser() user: AuthUser) {
    return this.staff.linkableUsers(user);
  }

  @RequirePermission("staff.manage")
  @Post("staff")
  create(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Body(new ZodValidationPipe(StaffInputSchema)) body: StaffInput) {
    return this.staff.create(user, { ...body, outletId: body.outletId || outletId });
  }

  @RequirePermission("staff.manage")
  @Patch("staff/:id")
  update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(UpdateStaffSchema)) body: UpdateStaffInput) {
    return this.staff.update(user, id, body);
  }

  @RequirePermission("staff.manage")
  @Put("staff/:id/pin")
  setPin(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(SetPinSchema)) body: SetPinInput) {
    return this.staff.setPin(user, id, body.pin);
  }

  // ---------- POS clock ----------

  @RequirePermission("attendance.clock")
  @Get("clock/staff")
  clockBoard(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.staff.clockBoard(user, outletId);
  }

  @RequirePermission("attendance.clock")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post("clock")
  clock(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Body(new ZodValidationPipe(ClockActionSchema)) body: ClockActionInput) {
    return this.staff.clock(user, outletId, body);
  }

  // ---------- Attendance ----------

  @RequirePermission("staff.manage")
  @Get("attendance/daily")
  daily(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Query("date") d?: string) {
    return this.staff.daily(user, outletId, date(d, istDateOf(new Date())));
  }

  @RequirePermission("staff.manage")
  @Get("attendance/register")
  register(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Query("from") from?: string, @Query("to") to?: string) {
    const t = date(to, istDateOf(new Date()));
    return this.staff.register(user, outletId, date(from, `${t.slice(0, 7)}-01`), t);
  }

  @RequirePermission("attendance.correct")
  @Post("attendance/corrections")
  correct(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(AttendanceCorrectionSchema)) body: AttendanceCorrectionInput,
  ) {
    return this.staff.correct(user, outletId, body);
  }

  // ---------- Shift templates + roster ----------

  @RequirePermission("staff.manage")
  @Get("shift-templates")
  templates(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.roster.templates(user, outletId);
  }

  @RequirePermission("staff.manage")
  @Post("shift-templates")
  createTemplate(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(ShiftTemplateSchema)) body: ShiftTemplateInput,
  ) {
    return this.roster.createTemplate(user, outletId, body);
  }

  @RequirePermission("staff.manage")
  @Patch("shift-templates/:id")
  updateTemplate(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ShiftTemplateSchema.partial())) body: Partial<ShiftTemplateInput>,
  ) {
    return this.roster.updateTemplate(user, outletId, id, body);
  }

  @RequirePermission("staff.manage")
  @Delete("shift-templates/:id")
  deleteTemplate(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.roster.deleteTemplate(user, outletId, id);
  }

  @RequirePermission("staff.manage")
  @Get("roster")
  week(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Query("weekStart") weekStart?: string) {
    return this.roster.week(user, outletId, date(weekStart, istDateOf(new Date())));
  }

  @RequirePermission("staff.manage")
  @Put("roster")
  assign(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Body(new ZodValidationPipe(RosterAssignSchema)) body: RosterAssignInput) {
    return this.roster.assign(user, outletId, body);
  }

  @RequirePermission("staff.manage")
  @Post("roster/copy")
  copy(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Body() body: { fromWeekStart?: string; toWeekStart?: string }) {
    const to = date(body?.toWeekStart, "");
    return this.roster.copyWeek(user, outletId, date(body?.fromWeekStart, addDays(to, -7)), to);
  }

  // ---------- Swaps ----------

  @RequirePermission("staff.manage")
  @Get("shift-swaps")
  swaps(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.roster.swaps(user, outletId);
  }

  @RequirePermission("attendance.clock")
  @Post("shift-swaps")
  requestSwap(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Body(new ZodValidationPipe(SwapRequestSchema)) body: SwapRequestInput) {
    return this.roster.requestSwap(user, outletId, body);
  }

  @RequirePermission("staff.manage")
  @Post("shift-swaps/:id/decide")
  decideSwap(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(DecisionSchema)) body: DecisionInput,
  ) {
    return this.roster.decideSwap(user, outletId, id, body);
  }

  // ---------- Leave ----------

  @RequirePermission("staff.manage")
  @Get("leave")
  leaves(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Query("status") status?: string) {
    return this.roster.leaves(user, outletId, status || undefined);
  }

  @RequirePermission("attendance.clock")
  @Post("leave")
  requestLeave(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Body(new ZodValidationPipe(LeaveRequestSchema)) body: LeaveRequestInput) {
    return this.roster.requestLeave(user, outletId, body);
  }

  @RequirePermission("staff.manage")
  @Post("leave/:id/decide")
  decideLeave(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(DecisionSchema)) body: DecisionInput,
  ) {
    return this.roster.decideLeave(user, outletId, id, body);
  }

  @RequirePermission("staff.manage")
  @Post("leave/:id/cancel")
  cancelLeave(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.roster.decideLeave(user, outletId, id, { cancel: true });
  }

  @RequirePermission("staff.manage")
  @Get("leave-balances")
  balances(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Query("year") year?: string) {
    const y = Number(year) || Number(istDateOf(new Date()).slice(0, 4));
    return this.roster.balances(user, outletId, y);
  }

  @RequirePermission("staff.manage")
  @Put("leave-balances")
  setBalance(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Body(new ZodValidationPipe(LeaveBalanceSchema)) body: LeaveBalanceInput) {
    return this.roster.setBalance(user, outletId, body);
  }

  // ---------- Payroll ----------

  @RequirePermission("payroll.manage")
  @Get("payroll/settings")
  config(@CurrentUser() user: AuthUser) {
    return this.payroll.getConfig(user);
  }

  @RequirePermission("payroll.manage")
  @Put("payroll/settings")
  setConfig(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(PayrollConfigSchema)) body: PayrollConfig) {
    return this.payroll.setConfig(user, body);
  }

  @RequirePermission("payroll.manage")
  @Get("payroll/advances")
  advances(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.payroll.advances(user, outletId);
  }

  @RequirePermission("payroll.manage")
  @Post("payroll/advances")
  giveAdvance(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Body(new ZodValidationPipe(SalaryAdvanceSchema)) body: SalaryAdvanceInput) {
    return this.payroll.giveAdvance(user, outletId, body);
  }

  @RequirePermission("payroll.manage")
  @Get("payroll/runs")
  runs(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.payroll.runs(user, outletId);
  }

  @RequirePermission("payroll.manage")
  @Post("payroll/runs")
  computeDraft(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Body(new ZodValidationPipe(CreatePayrollRunSchema)) body: CreatePayrollRunInput) {
    return this.payroll.computeDraft(user, outletId, body.month);
  }

  @RequirePermission("payroll.manage")
  @Get("payroll/runs/:id")
  run(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.payroll.run(user, outletId, id);
  }

  @RequirePermission("payroll.manage")
  @Patch("payroll/runs/:id/payslips/:payslipId")
  updatePayslip(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("id") id: string,
    @Param("payslipId") payslipId: string,
    @Body(new ZodValidationPipe(UpdatePayslipSchema)) body: UpdatePayslipInput,
  ) {
    return this.payroll.updatePayslip(user, outletId, id, payslipId, body);
  }

  @RequirePermission("payroll.manage")
  @Post("payroll/runs/:id/finalise")
  finalise(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.payroll.finalise(user, outletId, id);
  }

  @RequirePermission("payroll.manage")
  @Delete("payroll/runs/:id")
  deleteDraft(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.payroll.deleteDraft(user, outletId, id);
  }

  @RequirePermission("payroll.manage")
  @Get("payroll/runs/:id/csv")
  csv(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("id") id: string) {
    return this.payroll.csv(user, outletId, id);
  }

  // ---------- Performance ----------

  @RequirePermission("reports.view")
  @Get("reports/staff-sales")
  sales(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Query("from") from?: string, @Query("to") to?: string) {
    const t = date(to, istDateOf(new Date()));
    return this.payroll.salesPerformance(user, outletId, date(from, addDays(t, -29)), t);
  }
}
