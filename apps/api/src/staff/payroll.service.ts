import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AuthUser,
  MonthAttendanceSummary,
  PayAdjustment,
  PayComponent,
  PayInputs,
  PayrollConfig,
  PayrollRunDto,
  PayrollRunRowDto,
  PayslipCalc,
  PayslipDto,
  PayType,
  SalaryAdvanceDto,
  SalaryAdvanceInput,
  StaffSalesRowDto,
  UpdatePayslipInput,
} from "@stello/shared";
import {
  computePayslip,
  daysInMonth,
  fromPaise,
  istDateOf,
  istRange,
  PayrollConfigSchema,
  summariseMonth,
  toPaise,
} from "@stello/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { asDate, dateStr, loadAttendanceDays, loadPayrollConfig, N, rulesFromConfig } from "./staff.service";

type PayslipRow = Prisma.PayslipGetPayload<object>;
type Snapshot = { pay: Omit<PayInputs, "lopDays" | "overtimeMinutes" | "adjustments">; attendance: MonthAttendanceSummary };

@Injectable()
export class PayrollService {
  constructor(private readonly prisma: PrismaService) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  // ---------- Settings ----------

  getConfig(user: AuthUser): Promise<PayrollConfig> {
    return loadPayrollConfig(this.prisma, user.tenantId);
  }

  async setConfig(user: AuthUser, config: PayrollConfig): Promise<PayrollConfig> {
    const parsed = PayrollConfigSchema.parse(config);
    await this.prisma.payrollSetting.upsert({
      where: { tenantId: user.tenantId },
      create: { tenantId: user.tenantId, config: parsed },
      update: { config: parsed },
    });
    await this.prisma.auditLog.create({
      data: { tenantId: user.tenantId, userId: user.id, action: "PAYROLL_SETTINGS_UPDATED", entity: "payroll_settings", data: parsed },
    });
    return parsed;
  }

  // ---------- Advances ----------

  async advances(user: AuthUser, outletId: string): Promise<SalaryAdvanceDto[]> {
    this.assertOutlet(user, outletId);
    const rows = await this.prisma.salaryAdvance.findMany({
      where: { tenantId: user.tenantId, outletId },
      orderBy: [{ status: "desc" }, { givenOn: "desc" }],
      take: 200,
    });
    const staff = await this.prisma.staffMember.findMany({ where: { tenantId: user.tenantId, id: { in: rows.map((r) => r.staffId) } }, select: { id: true, name: true } });
    const nameBy = new Map(staff.map((s) => [s.id, s.name]));
    return rows.map((a) => ({
      id: a.id,
      staffId: a.staffId,
      staffName: nameBy.get(a.staffId) ?? "",
      amount: N(a.amount),
      monthlyRecovery: N(a.monthlyRecovery),
      recovered: N(a.recovered),
      outstanding: fromPaise(toPaise(N(a.amount)) - toPaise(N(a.recovered))),
      givenOn: dateStr(a.givenOn),
      paidFrom: a.paidFrom as SalaryAdvanceDto["paidFrom"],
      status: a.status as SalaryAdvanceDto["status"],
      note: a.note,
    }));
  }

  async giveAdvance(user: AuthUser, outletId: string, input: SalaryAdvanceInput): Promise<{ id: string }> {
    this.assertOutlet(user, outletId);
    const staff = await this.prisma.staffMember.findFirst({ where: { id: input.staffId, tenantId: user.tenantId, outletId } });
    if (!staff) throw new NotFoundException("Staff member not found");
    if (input.monthlyRecovery > input.amount) throw new BadRequestException("Monthly recovery cannot exceed the advance");
    const id = await this.prisma.$transaction(async (tx) => {
      if (input.paidFrom === "CASH_DRAWER") {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM cash_sessions WHERE "tenantId" = ${user.tenantId} AND "outletId" = ${outletId} AND status = 'OPEN' FOR UPDATE`;
        if (!rows.length) throw new BadRequestException("Open the cash drawer to pay an advance from it");
        await tx.cashMovement.create({
          data: { sessionId: rows[0].id, type: "PAY_OUT", amount: -input.amount, category: "SALARY_ADVANCE", note: `Advance: ${staff.name}` },
        });
      }
      const a = await tx.salaryAdvance.create({
        data: {
          tenantId: user.tenantId,
          outletId,
          staffId: staff.id,
          amount: input.amount,
          monthlyRecovery: input.monthlyRecovery,
          givenOn: asDate(input.givenOn),
          paidFrom: input.paidFrom,
          note: input.note ?? null,
          createdById: user.id,
        },
      });
      await tx.auditLog.create({
        data: { tenantId: user.tenantId, userId: user.id, action: "SALARY_ADVANCE", entity: "salary_advance", entityId: a.id, data: { staffId: staff.id, amount: input.amount } },
      });
      return a.id;
    });
    return { id };
  }

  // ---------- Runs ----------

  async runs(user: AuthUser, outletId: string): Promise<PayrollRunRowDto[]> {
    this.assertOutlet(user, outletId);
    const runs = await this.prisma.payrollRun.findMany({
      where: { tenantId: user.tenantId, outletId },
      include: { payslips: { select: { net: true, employerCost: true } } },
      orderBy: { month: "desc" },
    });
    return runs.map((r) => ({
      id: r.id,
      month: r.month,
      status: r.status as PayrollRunRowDto["status"],
      staffCount: r.payslips.length,
      net: fromPaise(r.payslips.reduce((s, p) => s + toPaise(N(p.net)), 0)),
      employerCost: fromPaise(r.payslips.reduce((s, p) => s + toPaise(N(p.employerCost)), 0)),
    }));
  }

  /**
   * Create (or recompute) the draft run for a month from attendance, leave,
   * roster and pay profiles. Manual adjustments and notes on existing draft
   * payslips are kept; LOP/overtime overrides are reset to the computed values.
   */
  async computeDraft(user: AuthUser, outletId: string, month: string): Promise<PayrollRunDto> {
    this.assertOutlet(user, outletId);
    const config = await loadPayrollConfig(this.prisma, user.tenantId);
    const rules = rulesFromConfig(config);
    const dim = daysInMonth(month);
    const from = `${month}-01`;
    const to = `${month}-${String(dim).padStart(2, "0")}`;
    const runId = await this.prisma.$transaction(
      async (tx) => {
        await tx.payrollRun.upsert({
          where: { outletId_month: { outletId, month } },
          create: { tenantId: user.tenantId, outletId, month, config, createdById: user.id },
          update: {},
        });
        const locked = await tx.$queryRaw<{ id: string; status: string }[]>`
          SELECT id, status FROM payroll_runs WHERE "outletId" = ${outletId} AND month = ${month}
          AND "tenantId" = ${user.tenantId} FOR UPDATE`;
        if (!locked.length) throw new NotFoundException("Payroll run not found");
        const run = locked[0];
        if (run.status !== "DRAFT") throw new BadRequestException(`Payroll for ${month} is finalised`);
        await tx.payrollRun.update({ where: { id: run.id }, data: { config } });

        const staff = await tx.staffMember.findMany({
          where: {
            tenantId: user.tenantId,
            outletId,
            joiningDate: { lte: asDate(to) },
            OR: [{ exitDate: null }, { exitDate: { gte: asDate(from) } }],
          },
        });
        const active = staff.filter((s) => s.isActive || s.exitDate);
        const [days, advances, existing] = await Promise.all([
          loadAttendanceDays(tx, user.tenantId, active, from, to),
          tx.salaryAdvance.findMany({ where: { tenantId: user.tenantId, staffId: { in: active.map((s) => s.id) }, status: "OPEN", givenOn: { lte: asDate(to) } } }),
          tx.payslip.findMany({ where: { tenantId: user.tenantId, runId: run.id } }),
        ]);
        const keepBy = new Map(existing.map((p) => [p.staffId, p]));
        const included = new Set<string>();
        for (const s of active) {
          // Days still ahead (a run before month end) are assumed worked, never loss-of-pay.
          const today = istDateOf(new Date());
          const list = days.get(s.id)!.map((d) => (d.date > today && d.employed ? { ...d, shift: null } : d));
          const attendance = summariseMonth(list, rules);
          const advanceDue = advances
            .filter((a) => a.staffId === s.id)
            .reduce((sum, a) => sum + Math.min(toPaise(N(a.monthlyRecovery)), toPaise(N(a.amount)) - toPaise(N(a.recovered))), 0);
          const pay: Snapshot["pay"] = {
            payType: s.payType as PayType,
            payRate: N(s.payRate),
            allowances: (s.allowances as PayComponent[] | null) ?? [],
            deductions: (s.deductions as PayComponent[] | null) ?? [],
            pfApplicable: s.pfApplicable,
            esiApplicable: s.esiApplicable,
            ptApplicable: s.ptApplicable,
            overtimeEligible: s.overtimeEligible,
            daysInMonth: dim,
            presentDays: attendance.presentDays,
            paidLeaveDays: attendance.paidLeaveDays,
            workedMinutes: attendance.workedMinutes,
            advanceDue: fromPaise(advanceDue),
          };
          const prev = keepBy.get(s.id);
          const adjustments = (prev?.adjustments as PayAdjustment[] | null) ?? [];
          const snapshot: Snapshot = { pay, attendance };
          const calc = computePayslip({ ...pay, lopDays: attendance.lopDays, overtimeMinutes: attendance.overtimeMinutes, adjustments }, config);
          const data = {
            staffName: s.name,
            employeeCode: s.employeeCode,
            designation: s.designation,
            payType: s.payType,
            payRate: s.payRate,
            inputs: snapshot as unknown as Prisma.InputJsonValue,
            lopDays: attendance.lopDays,
            overtimeMinutes: attendance.overtimeMinutes,
            adjustments: adjustments as unknown as Prisma.InputJsonValue,
            ...this.calcColumns(calc),
          };
          await tx.payslip.upsert({
            where: { runId_staffId: { runId: run.id, staffId: s.id } },
            create: { tenantId: user.tenantId, runId: run.id, staffId: s.id, ...data },
            update: data,
          });
          included.add(s.id);
        }
        // Staff no longer eligible (e.g. moved outlet) drop out of the draft.
        await tx.payslip.deleteMany({ where: { tenantId: user.tenantId, runId: run.id, staffId: { notIn: [...included] } } });
        return run.id;
      },
      { timeout: 30000 },
    );
    return this.run(user, outletId, runId);
  }

  private calcColumns(calc: PayslipCalc) {
    return {
      calc: calc as unknown as Prisma.InputJsonValue,
      gross: calc.gross,
      totalDeductions: calc.totalDeductions,
      net: calc.net,
      employerCost: fromPaise(toPaise(calc.gross) + toPaise(calc.pfEmployer) + toPaise(calc.esiEmployer)),
      advanceRecovery: calc.advanceRecovery,
    };
  }

  async run(user: AuthUser, outletId: string, id: string): Promise<PayrollRunDto> {
    this.assertOutlet(user, outletId);
    const run = await this.prisma.payrollRun.findFirst({
      where: { id, tenantId: user.tenantId, outletId },
      include: { payslips: { orderBy: { staffName: "asc" } } },
    });
    if (!run) throw new NotFoundException("Payroll run not found");
    const outlet = await this.prisma.outlet.findFirst({ where: { id: outletId, tenantId: user.tenantId }, select: { name: true } });
    const payslips = run.payslips.map((p) => this.toPayslipDto(p));
    const sum = (f: (p: PayslipDto) => number) => fromPaise(payslips.reduce((s, p) => s + toPaise(f(p)), 0));
    return {
      id: run.id,
      outletId,
      outletName: outlet?.name ?? "",
      month: run.month,
      status: run.status as PayrollRunDto["status"],
      config: PayrollConfigSchema.parse(run.config),
      totals: {
        gross: sum((p) => p.calc.gross),
        deductions: sum((p) => p.calc.totalDeductions),
        net: sum((p) => p.calc.net),
        employerCost: sum((p) => p.calc.gross + p.calc.pfEmployer + p.calc.esiEmployer),
      },
      finalisedAt: run.finalisedAt?.toISOString() ?? null,
      payslips,
    };
  }

  /** Edit a draft payslip (LOP / overtime override, adjustments, note) and recompute it. */
  async updatePayslip(user: AuthUser, outletId: string, runId: string, payslipId: string, input: UpdatePayslipInput): Promise<PayslipDto> {
    this.assertOutlet(user, outletId);
    const updated = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT id, status FROM payroll_runs WHERE id = ${runId} AND "tenantId" = ${user.tenantId} AND "outletId" = ${outletId} FOR UPDATE`;
      if (!rows.length) throw new NotFoundException("Payroll run not found");
      if (rows[0].status !== "DRAFT") throw new BadRequestException("Payroll is finalised and locked");
      const run = await tx.payrollRun.findFirstOrThrow({ where: { id: runId, tenantId: user.tenantId } });
      const p = await tx.payslip.findFirst({ where: { id: payslipId, runId, tenantId: user.tenantId } });
      if (!p) throw new NotFoundException("Payslip not found");
      const snap = p.inputs as unknown as Snapshot;
      const lopDays = input.lopDays ?? N(p.lopDays);
      if (lopDays > snap.pay.daysInMonth) throw new BadRequestException("LOP days exceed the month");
      const overtimeMinutes = input.overtimeMinutes ?? p.overtimeMinutes;
      const adjustments = input.adjustments ?? ((p.adjustments as PayAdjustment[] | null) ?? []);
      const calc = computePayslip({ ...snap.pay, lopDays, overtimeMinutes, adjustments }, PayrollConfigSchema.parse(run.config));
      return tx.payslip.update({
        where: { id: p.id },
        data: {
          lopDays,
          overtimeMinutes,
          adjustments: adjustments as unknown as Prisma.InputJsonValue,
          note: input.note === undefined ? undefined : input.note,
          ...this.calcColumns(calc),
        },
      });
    });
    return this.toPayslipDto(updated);
  }

  /**
   * Lock a run. Advance recoveries are booked against the staff member's open
   * advances (oldest first) under row locks; if the advances changed since the
   * draft was computed the run must be recomputed first.
   */
  async finalise(user: AuthUser, outletId: string, runId: string): Promise<PayrollRunDto> {
    this.assertOutlet(user, outletId);
    await this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ id: string; status: string }[]>`
          SELECT id, status FROM payroll_runs WHERE id = ${runId} AND "tenantId" = ${user.tenantId} AND "outletId" = ${outletId} FOR UPDATE`;
        if (!rows.length) throw new NotFoundException("Payroll run not found");
        if (rows[0].status !== "DRAFT") throw new BadRequestException("Payroll is already finalised");
        const payslips = await tx.payslip.findMany({ where: { runId, tenantId: user.tenantId } });
        if (!payslips.length) throw new BadRequestException("No payslips to finalise");
        for (const p of payslips) {
          let remaining = toPaise(N(p.advanceRecovery));
          if (remaining <= 0) continue;
          const advances = await tx.$queryRaw<{ id: string; amount: Prisma.Decimal; recovered: Prisma.Decimal }[]>`
            SELECT id, amount, recovered FROM salary_advances WHERE "staffId" = ${p.staffId} AND "tenantId" = ${user.tenantId}
            AND status = 'OPEN' ORDER BY "givenOn" ASC, id ASC FOR UPDATE`;
          for (const a of advances) {
            if (remaining <= 0) break;
            const outstanding = toPaise(N(a.amount)) - toPaise(N(a.recovered));
            const take = Math.min(outstanding, remaining);
            remaining -= take;
            const recovered = toPaise(N(a.recovered)) + take;
            await tx.salaryAdvance.update({
              where: { id: a.id },
              data: { recovered: fromPaise(recovered), status: recovered >= toPaise(N(a.amount)) ? "CLOSED" : "OPEN" },
            });
          }
          if (remaining > 0) throw new BadRequestException(`Advances for ${p.staffName} changed — recompute the draft`);
        }
        await tx.payrollRun.update({ where: { id: runId }, data: { status: "FINALISED", finalisedAt: new Date(), finalisedById: user.id } });
        await tx.auditLog.create({
          data: {
            tenantId: user.tenantId,
            userId: user.id,
            action: "PAYROLL_FINALISED",
            entity: "payroll_run",
            entityId: runId,
            data: { net: fromPaise(payslips.reduce((s, p) => s + toPaise(N(p.net)), 0)), staff: payslips.length },
          },
        });
      },
      { timeout: 30000 },
    );
    return this.run(user, outletId, runId);
  }

  async deleteDraft(user: AuthUser, outletId: string, runId: string): Promise<{ id: string }> {
    this.assertOutlet(user, outletId);
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT id, status FROM payroll_runs WHERE id = ${runId} AND "tenantId" = ${user.tenantId} AND "outletId" = ${outletId} FOR UPDATE`;
      if (!rows.length) throw new NotFoundException("Payroll run not found");
      if (rows[0].status !== "DRAFT") throw new BadRequestException("A finalised payroll cannot be deleted");
      await tx.payrollRun.delete({ where: { id: runId } });
    });
    return { id: runId };
  }

  async csv(user: AuthUser, outletId: string, runId: string): Promise<{ filename: string; csv: string }> {
    const run = await this.run(user, outletId, runId);
    const cell = (v: string | number | null) => {
      const s = v == null ? "" : String(v);
      // Neutralise spreadsheet formula injection, then quote.
      const safe = /^[=+\-@]/.test(s) && typeof v === "string" ? `'${s}` : s;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const header = [
      "Employee code", "Name", "Designation", "Pay type", "Rate", "Days in month", "Present days", "Paid leave", "LOP days",
      "OT hours", "Basic", "Overtime", "Other earnings", "Gross", "PF (employee)", "ESI (employee)", "Professional tax",
      "Advance recovery", "Other deductions", "Total deductions", "Net pay", "PF (employer)", "ESI (employer)",
    ];
    const lines = run.payslips.map((p) =>
      [
        p.employeeCode, p.staffName, p.designation, p.payType, p.payRate, p.daysInMonth, p.attendance.presentDays,
        p.attendance.paidLeaveDays, p.lopDays, p.calc.overtimeHours, p.calc.basic, p.calc.overtimePay,
        fromPaise(p.calc.earnings.reduce((s, l) => s + toPaise(l.amount), 0)), p.calc.gross, p.calc.pfEmployee,
        p.calc.esiEmployee, p.calc.professionalTax, p.calc.advanceRecovery,
        fromPaise(p.calc.otherDeductions.reduce((s, l) => s + toPaise(l.amount), 0)), p.calc.totalDeductions, p.calc.net,
        p.calc.pfEmployer, p.calc.esiEmployer,
      ].map(cell).join(","),
    );
    return { filename: `payroll-${run.month}-${run.outletName.replace(/[^\w]+/g, "-")}.csv`, csv: [header.map(cell).join(","), ...lines].join("\r\n") };
  }

  // ---------- Staff sales performance ----------

  /** Orders taken (by creator) and bills settled (by settler) per user, from existing order data. */
  async salesPerformance(user: AuthUser, outletId: string, from: string, to: string): Promise<StaffSalesRowDto[]> {
    this.assertOutlet(user, outletId);
    const range = istRange(from, to);
    const orders = await this.prisma.order.findMany({
      where: { tenantId: user.tenantId, outletId, status: "SETTLED", createdAt: range },
      select: { id: true, createdById: true, subtotal: true, discountAmount: true, total: true, items: { select: { quantity: true, isComboComponent: true } } },
    });
    const settles = orders.length
      ? await this.prisma.auditLog.findMany({
          where: { tenantId: user.tenantId, action: "ORDER_SETTLED", entityId: { in: orders.map((o) => o.id) } },
          select: { userId: true, entityId: true },
        })
      : [];
    const settledBy = new Map(settles.map((s) => [s.entityId, s.userId]));
    type Acc = { orders: number; sales: number; items: number; settled: number; settledAmt: number };
    const acc = new Map<string, Acc>();
    const get = (id: string) => acc.get(id) ?? (acc.set(id, { orders: 0, sales: 0, items: 0, settled: 0, settledAmt: 0 }), acc.get(id)!);
    for (const o of orders) {
      if (o.createdById) {
        const a = get(o.createdById);
        a.orders += 1;
        a.sales += toPaise(N(o.subtotal)) - toPaise(N(o.discountAmount));
        a.items += o.items.filter((i) => !i.isComboComponent).reduce((s, i) => s + i.quantity, 0);
      }
      const settler = settledBy.get(o.id);
      if (settler) {
        const a = get(settler);
        a.settled += 1;
        a.settledAmt += toPaise(N(o.total));
      }
    }
    const ids = [...acc.keys()];
    const [users, staff] = await Promise.all([
      this.prisma.user.findMany({ where: { tenantId: user.tenantId, id: { in: ids } }, select: { id: true, name: true } }),
      this.prisma.staffMember.findMany({ where: { tenantId: user.tenantId, userId: { in: ids } }, select: { id: true, userId: true } }),
    ]);
    const nameBy = new Map(users.map((u) => [u.id, u.name]));
    const staffBy = new Map(staff.map((s) => [s.userId, s.id]));
    return ids
      .map((id) => {
        const a = acc.get(id)!;
        return {
          userId: id,
          name: nameBy.get(id) ?? "Unknown user",
          staffId: staffBy.get(id) ?? null,
          ordersTaken: a.orders,
          salesTaken: fromPaise(a.sales),
          avgTicket: a.orders ? fromPaise(Math.round(a.sales / a.orders)) : 0,
          itemsSold: a.items,
          billsSettled: a.settled,
          amountSettled: fromPaise(a.settledAmt),
        };
      })
      .sort((x, y) => y.salesTaken - x.salesTaken);
  }

  private toPayslipDto(p: PayslipRow): PayslipDto {
    const snap = p.inputs as unknown as Snapshot;
    return {
      id: p.id,
      staffId: p.staffId,
      staffName: p.staffName,
      employeeCode: p.employeeCode,
      designation: p.designation,
      payType: p.payType as PayType,
      payRate: N(p.payRate),
      daysInMonth: snap.pay.daysInMonth,
      attendance: snap.attendance,
      lopDays: N(p.lopDays),
      overtimeMinutes: p.overtimeMinutes,
      adjustments: (p.adjustments as PayAdjustment[] | null) ?? [],
      calc: p.calc as unknown as PayslipCalc,
      note: p.note,
    };
  }
}
