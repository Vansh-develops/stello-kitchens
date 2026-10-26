import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AuthUser,
  DecisionInput,
  LeaveBalanceDto,
  LeaveBalanceInput,
  LeaveRequestDto,
  LeaveRequestInput,
  LeaveType,
  RequestStatus,
  RosterAssignInput,
  RosterShiftDto,
  RosterWeekDto,
  ShiftTemplateDto,
  ShiftTemplateInput,
  SwapRequestDto,
  SwapRequestInput,
} from "@stello/shared";
import { addDays, leaveDays } from "@stello/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { asDate, dateStr, hasPerm, N } from "./staff.service";

type ShiftRow = Prisma.RosterShiftGetPayload<object>;
const PAID_TYPES = ["CASUAL", "SICK", "EARNED"] as const;

@Injectable()
export class RosterService {
  constructor(private readonly prisma: PrismaService) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  // ---------- Shift templates ----------

  async templates(user: AuthUser, outletId: string): Promise<ShiftTemplateDto[]> {
    this.assertOutlet(user, outletId);
    const rows = await this.prisma.shiftTemplate.findMany({
      where: { tenantId: user.tenantId, outletId, isActive: true },
      orderBy: { startTime: "asc" },
    });
    return rows.map((t) => ({ id: t.id, name: t.name, startTime: t.startTime, endTime: t.endTime, breakMinutes: t.breakMinutes, graceMinutes: t.graceMinutes }));
  }

  async createTemplate(user: AuthUser, outletId: string, input: ShiftTemplateInput): Promise<ShiftTemplateDto> {
    this.assertOutlet(user, outletId);
    if (input.startTime === input.endTime) throw new BadRequestException("Shift start and end cannot be equal");
    const t = await this.prisma.shiftTemplate.create({ data: { tenantId: user.tenantId, outletId, ...input } });
    return { id: t.id, name: t.name, startTime: t.startTime, endTime: t.endTime, breakMinutes: t.breakMinutes, graceMinutes: t.graceMinutes };
  }

  async updateTemplate(user: AuthUser, outletId: string, id: string, input: Partial<ShiftTemplateInput>): Promise<{ id: string }> {
    this.assertOutlet(user, outletId);
    const t = await this.prisma.shiftTemplate.findFirst({ where: { id, tenantId: user.tenantId, outletId } });
    if (!t) throw new NotFoundException("Shift template not found");
    await this.prisma.shiftTemplate.update({ where: { id }, data: input });
    return { id };
  }

  /** Templates are soft-deleted: rostered shifts keep their snapshot times. */
  async deleteTemplate(user: AuthUser, outletId: string, id: string): Promise<{ id: string }> {
    this.assertOutlet(user, outletId);
    const t = await this.prisma.shiftTemplate.findFirst({ where: { id, tenantId: user.tenantId, outletId } });
    if (!t) throw new NotFoundException("Shift template not found");
    await this.prisma.shiftTemplate.update({ where: { id }, data: { isActive: false } });
    return { id };
  }

  // ---------- Weekly roster ----------

  async week(user: AuthUser, outletId: string, weekStart: string): Promise<RosterWeekDto> {
    this.assertOutlet(user, outletId);
    const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    const end = dates[6];
    const [staff, shifts, templates, leaves] = await Promise.all([
      this.prisma.staffMember.findMany({
        where: { tenantId: user.tenantId, outletId, isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, designation: true },
      }),
      this.prisma.rosterShift.findMany({ where: { tenantId: user.tenantId, outletId, date: { gte: asDate(weekStart), lte: asDate(end) } } }),
      this.prisma.shiftTemplate.findMany({ where: { tenantId: user.tenantId, outletId } }),
      this.prisma.leaveRequest.findMany({
        where: { tenantId: user.tenantId, outletId, status: "APPROVED", fromDate: { lte: asDate(end) }, toDate: { gte: asDate(weekStart) } },
      }),
    ]);
    const tName = new Map(templates.map((t) => [t.id, t.name]));
    const leaveCells: RosterWeekDto["leaves"] = [];
    for (const l of leaves) {
      for (let d = dateStr(l.fromDate); d <= dateStr(l.toDate); d = addDays(d, 1)) {
        if (d >= weekStart && d <= end) leaveCells.push({ staffId: l.staffId, date: d, type: l.type as LeaveType });
      }
    }
    return { weekStart, dates, staff, shifts: shifts.map((s) => this.toShiftDto(s, tName)), leaves: leaveCells };
  }

  async assign(user: AuthUser, outletId: string, input: RosterAssignInput): Promise<{ updated: number }> {
    this.assertOutlet(user, outletId);
    const staffIds = [...new Set(input.entries.map((e) => e.staffId))];
    const templateIds = [...new Set(input.entries.map((e) => e.templateId).filter((x): x is string => !!x))];
    const [staff, templates] = await Promise.all([
      this.prisma.staffMember.findMany({ where: { tenantId: user.tenantId, outletId, id: { in: staffIds } }, select: { id: true } }),
      this.prisma.shiftTemplate.findMany({ where: { tenantId: user.tenantId, outletId, id: { in: templateIds } } }),
    ]);
    if (staff.length !== staffIds.length) throw new BadRequestException("Unknown staff member for this outlet");
    if (templates.length !== templateIds.length) throw new BadRequestException("Unknown shift template for this outlet");
    const tBy = new Map(templates.map((t) => [t.id, t]));
    await this.prisma.$transaction(async (tx) => {
      for (const e of input.entries) {
        const where = { staffId_date: { staffId: e.staffId, date: asDate(e.date) } };
        if (!e.templateId) {
          await tx.rosterShift.deleteMany({ where: { tenantId: user.tenantId, staffId: e.staffId, date: asDate(e.date) } });
          continue;
        }
        const t = tBy.get(e.templateId)!;
        const times = { templateId: t.id, startTime: t.startTime, endTime: t.endTime, breakMinutes: t.breakMinutes, graceMinutes: t.graceMinutes };
        await tx.rosterShift.upsert({
          where,
          create: { tenantId: user.tenantId, outletId, staffId: e.staffId, date: asDate(e.date), ...times },
          update: times,
        });
      }
    });
    return { updated: input.entries.length };
  }

  /** Copy one week's roster onto another (overwrites the target week's shifts). */
  async copyWeek(user: AuthUser, outletId: string, fromWeek: string, toWeek: string): Promise<{ copied: number }> {
    this.assertOutlet(user, outletId);
    const src = await this.prisma.rosterShift.findMany({
      where: { tenantId: user.tenantId, outletId, date: { gte: asDate(fromWeek), lte: asDate(addDays(fromWeek, 6)) } },
    });
    const offset = Math.round((asDate(toWeek).getTime() - asDate(fromWeek).getTime()) / 86400000);
    await this.prisma.$transaction(async (tx) => {
      await tx.rosterShift.deleteMany({ where: { tenantId: user.tenantId, outletId, date: { gte: asDate(toWeek), lte: asDate(addDays(toWeek, 6)) } } });
      if (src.length) {
        await tx.rosterShift.createMany({
          data: src.map((s) => ({
            tenantId: user.tenantId,
            outletId,
            staffId: s.staffId,
            date: asDate(addDays(dateStr(s.date), offset)),
            templateId: s.templateId,
            startTime: s.startTime,
            endTime: s.endTime,
            breakMinutes: s.breakMinutes,
            graceMinutes: s.graceMinutes,
          })),
          skipDuplicates: true,
        });
      }
    });
    return { copied: src.length };
  }

  // ---------- Swaps ----------

  async swaps(user: AuthUser, outletId: string): Promise<SwapRequestDto[]> {
    this.assertOutlet(user, outletId);
    const reqs = await this.prisma.shiftSwapRequest.findMany({
      where: { tenantId: user.tenantId, outletId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const shiftIds = reqs.flatMap((r) => [r.fromShiftId, r.toShiftId]).filter((x): x is string => !!x);
    const [shifts, staff, templates] = await Promise.all([
      this.prisma.rosterShift.findMany({ where: { tenantId: user.tenantId, id: { in: shiftIds } } }),
      this.prisma.staffMember.findMany({ where: { tenantId: user.tenantId, outletId }, select: { id: true, name: true } }),
      this.prisma.shiftTemplate.findMany({ where: { tenantId: user.tenantId, outletId } }),
    ]);
    const sBy = new Map(shifts.map((s) => [s.id, s]));
    const nameBy = new Map(staff.map((s) => [s.id, s.name]));
    const tName = new Map(templates.map((t) => [t.id, t.name]));
    const withName = (s: ShiftRow) => ({ ...this.toShiftDto(s, tName), staffName: nameBy.get(s.staffId) ?? "" });
    return reqs
      .filter((r) => sBy.has(r.fromShiftId) || r.status !== "PENDING")
      .map((r) => {
        const from = sBy.get(r.fromShiftId);
        const to = r.toShiftId ? sBy.get(r.toShiftId) : null;
        return {
          id: r.id,
          fromShift: from ? withName(from) : ({ id: r.fromShiftId, staffName: "(changed)" } as SwapRequestDto["fromShift"]),
          toStaffId: r.toStaffId,
          toStaffName: nameBy.get(r.toStaffId) ?? "",
          toShift: to ? withName(to) : null,
          reason: r.reason,
          status: r.status as RequestStatus,
          createdAt: r.createdAt.toISOString(),
        };
      });
  }

  async requestSwap(user: AuthUser, outletId: string, input: SwapRequestInput): Promise<{ id: string }> {
    this.assertOutlet(user, outletId);
    const from = await this.prisma.rosterShift.findFirst({ where: { id: input.fromShiftId, tenantId: user.tenantId, outletId } });
    if (!from) throw new NotFoundException("Shift not found");
    await this.assertSelfOrManager(user, from.staffId);
    const toStaff = await this.prisma.staffMember.findFirst({ where: { id: input.toStaffId, tenantId: user.tenantId, outletId, isActive: true } });
    if (!toStaff || toStaff.id === from.staffId) throw new BadRequestException("Pick another active staff member of this outlet");
    if (input.toShiftId) {
      const to = await this.prisma.rosterShift.findFirst({ where: { id: input.toShiftId, tenantId: user.tenantId, outletId, staffId: toStaff.id } });
      if (!to) throw new BadRequestException("The other shift must belong to the chosen staff member");
    }
    const r = await this.prisma.shiftSwapRequest.create({
      data: {
        tenantId: user.tenantId,
        outletId,
        fromShiftId: from.id,
        toStaffId: toStaff.id,
        toShiftId: input.toShiftId ?? null,
        reason: input.reason ?? null,
        requestedById: user.id,
      },
    });
    return { id: r.id };
  }

  /**
   * Approve/reject a swap. On approval the shifts are re-checked under row locks
   * (they may have been edited since the request) and the one-shift-per-day rule
   * is enforced for both people.
   */
  async decideSwap(user: AuthUser, outletId: string, id: string, input: DecisionInput): Promise<{ id: string; status: RequestStatus }> {
    this.assertOutlet(user, outletId);
    const status = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT id, status FROM shift_swap_requests WHERE id = ${id} AND "tenantId" = ${user.tenantId}
        AND "outletId" = ${outletId} FOR UPDATE`;
      if (!rows.length) throw new NotFoundException("Swap request not found");
      if (rows[0].status !== "PENDING") throw new BadRequestException("Request was already decided");
      const req = await tx.shiftSwapRequest.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
      const decided = { decidedById: user.id, decidedAt: new Date(), decisionNote: input.note ?? null };
      if (!input.approve) {
        await tx.shiftSwapRequest.update({ where: { id }, data: { status: "REJECTED", ...decided } });
        return "REJECTED" as const;
      }
      const ids = [req.fromShiftId, req.toShiftId].filter((x): x is string => !!x).sort();
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM roster_shifts WHERE id IN (${Prisma.join(ids)}) AND "tenantId" = ${user.tenantId} FOR UPDATE`;
      if (locked.length !== ids.length) throw new BadRequestException("A shift in this request no longer exists");
      const from = await tx.rosterShift.findFirstOrThrow({ where: { id: req.fromShiftId, tenantId: user.tenantId } });
      const to = req.toShiftId ? await tx.rosterShift.findFirstOrThrow({ where: { id: req.toShiftId, tenantId: user.tenantId } }) : null;
      if (to && to.staffId !== req.toStaffId) throw new BadRequestException("The other shift has been reassigned");
      const clash = async (staffId: string, date: Date, ignore: string[]) =>
        tx.rosterShift.findFirst({ where: { tenantId: user.tenantId, staffId, date, id: { notIn: ignore } } });
      if (await clash(req.toStaffId, from.date, ids)) throw new BadRequestException("The covering staff member already has a shift that day");
      if (to && (await clash(from.staffId, to.date, ids))) throw new BadRequestException("The requester already has a shift on the other day");
      const fields = (s: ShiftRow) => ({
        tenantId: s.tenantId, outletId: s.outletId, date: s.date, templateId: s.templateId,
        startTime: s.startTime, endTime: s.endTime, breakMinutes: s.breakMinutes, graceMinutes: s.graceMinutes,
      });
      // Recreate both shifts with swapped owners (deleting first keeps the per-day unique key valid).
      await tx.rosterShift.deleteMany({ where: { tenantId: user.tenantId, id: { in: ids } } });
      await tx.rosterShift.create({ data: { ...fields(from), id: from.id, staffId: req.toStaffId } });
      if (to) await tx.rosterShift.create({ data: { ...fields(to), id: to.id, staffId: from.staffId } });
      await tx.shiftSwapRequest.update({ where: { id }, data: { status: "APPROVED", ...decided } });
      return "APPROVED" as const;
    });
    return { id, status };
  }

  // ---------- Leave ----------

  /** Non-managers may only raise requests for their own linked staff profile. */
  private async assertSelfOrManager(user: AuthUser, staffId: string) {
    if (hasPerm(user, "staff.manage")) return;
    const own = await this.prisma.staffMember.findFirst({ where: { id: staffId, tenantId: user.tenantId, userId: user.id } });
    if (!own) throw new ForbiddenException("You can only raise requests for yourself");
  }

  async leaves(user: AuthUser, outletId: string, status?: string): Promise<LeaveRequestDto[]> {
    this.assertOutlet(user, outletId);
    const rows = await this.prisma.leaveRequest.findMany({
      where: { tenantId: user.tenantId, outletId, ...(status ? { status } : {}) },
      include: { staff: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return rows.map((l) => ({
      id: l.id,
      staffId: l.staffId,
      staffName: l.staff.name,
      type: l.type as LeaveType,
      fromDate: dateStr(l.fromDate),
      toDate: dateStr(l.toDate),
      days: N(l.days),
      halfDay: l.halfDay,
      reason: l.reason,
      status: l.status as RequestStatus,
      decisionNote: l.decisionNote,
      createdAt: l.createdAt.toISOString(),
    }));
  }

  async requestLeave(user: AuthUser, outletId: string, input: LeaveRequestInput): Promise<{ id: string }> {
    this.assertOutlet(user, outletId);
    const staff = await this.prisma.staffMember.findFirst({ where: { id: input.staffId, tenantId: user.tenantId, outletId } });
    if (!staff) throw new NotFoundException("Staff member not found");
    await this.assertSelfOrManager(user, staff.id);
    if (input.fromDate.slice(0, 4) !== input.toDate.slice(0, 4)) throw new BadRequestException("Split leave that crosses a year into two requests");
    const overlap = await this.prisma.leaveRequest.findFirst({
      where: {
        tenantId: user.tenantId,
        staffId: staff.id,
        status: { in: ["PENDING", "APPROVED"] },
        fromDate: { lte: asDate(input.toDate) },
        toDate: { gte: asDate(input.fromDate) },
      },
    });
    if (overlap) throw new BadRequestException("Overlaps an existing leave request");
    const r = await this.prisma.leaveRequest.create({
      data: {
        tenantId: user.tenantId,
        outletId,
        staffId: staff.id,
        type: input.type,
        fromDate: asDate(input.fromDate),
        toDate: asDate(input.toDate),
        halfDay: input.halfDay,
        days: leaveDays(input.fromDate, input.toDate, input.halfDay),
        reason: input.reason ?? null,
        requestedById: user.id,
      },
    });
    return { id: r.id };
  }

  /**
   * Approve/reject/cancel leave. Approval debits the paid-leave balance under a
   * row lock so two approvals can never overdraw it; cancelling approved leave
   * credits it back.
   */
  async decideLeave(user: AuthUser, outletId: string, id: string, input: DecisionInput | { cancel: true }): Promise<{ id: string; status: RequestStatus }> {
    this.assertOutlet(user, outletId);
    const status = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM leave_requests WHERE id = ${id} AND "tenantId" = ${user.tenantId} AND "outletId" = ${outletId} FOR UPDATE`;
      if (!rows.length) throw new NotFoundException("Leave request not found");
      const l = await tx.leaveRequest.findFirstOrThrow({ where: { id, tenantId: user.tenantId } });
      const decided = { decidedById: user.id, decidedAt: new Date(), decisionNote: "note" in input ? (input.note ?? null) : null };
      const year = l.fromDate.getUTCFullYear();
      const paid = l.type !== "UNPAID";
      const lockBalance = async () => {
        await tx.leaveBalance.upsert({
          where: { staffId_year_type: { staffId: l.staffId, year, type: l.type } },
          create: { tenantId: user.tenantId, staffId: l.staffId, year, type: l.type },
          update: {},
        });
        const b = await tx.$queryRaw<{ id: string; allotted: Prisma.Decimal; used: Prisma.Decimal }[]>`
          SELECT id, allotted, used FROM leave_balances WHERE "staffId" = ${l.staffId} AND year = ${year}
          AND type = ${l.type} AND "tenantId" = ${user.tenantId} FOR UPDATE`;
        return b[0];
      };
      if ("cancel" in input) {
        if (l.status !== "PENDING" && l.status !== "APPROVED") throw new BadRequestException("Only pending or approved leave can be cancelled");
        if (l.status === "APPROVED" && paid) {
          const b = await lockBalance();
          await tx.leaveBalance.update({ where: { id: b.id }, data: { used: Math.max(0, N(b.used) - N(l.days)) } });
        }
        await tx.leaveRequest.update({ where: { id }, data: { status: "CANCELLED", ...decided } });
        return "CANCELLED" as const;
      }
      if (l.status !== "PENDING") throw new BadRequestException("Request was already decided");
      if (!input.approve) {
        await tx.leaveRequest.update({ where: { id }, data: { status: "REJECTED", ...decided } });
        return "REJECTED" as const;
      }
      if (paid) {
        const b = await lockBalance();
        const available = N(b.allotted) - N(b.used);
        if (available < N(l.days)) {
          throw new BadRequestException(`Insufficient ${l.type.toLowerCase()} leave: ${available} day(s) available`);
        }
        await tx.leaveBalance.update({ where: { id: b.id }, data: { used: N(b.used) + N(l.days) } });
      }
      await tx.leaveRequest.update({ where: { id }, data: { status: "APPROVED", ...decided } });
      return "APPROVED" as const;
    });
    return { id, status };
  }

  async balances(user: AuthUser, outletId: string, year: number): Promise<LeaveBalanceDto[]> {
    this.assertOutlet(user, outletId);
    const staff = await this.prisma.staffMember.findMany({
      where: { tenantId: user.tenantId, outletId, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });
    const rows = await this.prisma.leaveBalance.findMany({ where: { tenantId: user.tenantId, year, staffId: { in: staff.map((s) => s.id) } } });
    return staff.map((s) => ({
      staffId: s.id,
      staffName: s.name,
      year,
      balances: PAID_TYPES.map((type) => {
        const b = rows.find((r) => r.staffId === s.id && r.type === type);
        const allotted = N(b?.allotted);
        const used = N(b?.used);
        return { type, allotted, used, available: allotted - used };
      }),
    }));
  }

  async setBalance(user: AuthUser, outletId: string, input: LeaveBalanceInput): Promise<{ ok: true }> {
    this.assertOutlet(user, outletId);
    const staff = await this.prisma.staffMember.findFirst({ where: { id: input.staffId, tenantId: user.tenantId, outletId } });
    if (!staff) throw new NotFoundException("Staff member not found");
    await this.prisma.leaveBalance.upsert({
      where: { staffId_year_type: { staffId: staff.id, year: input.year, type: input.type } },
      create: { tenantId: user.tenantId, staffId: staff.id, year: input.year, type: input.type, allotted: input.allotted },
      update: { allotted: input.allotted },
    });
    return { ok: true };
  }

  private toShiftDto(s: ShiftRow, tName: Map<string, string>): RosterShiftDto {
    return {
      id: s.id,
      staffId: s.staffId,
      date: dateStr(s.date),
      templateId: s.templateId,
      templateName: s.templateId ? tName.get(s.templateId) ?? null : null,
      startTime: s.startTime,
      endTime: s.endTime,
      breakMinutes: s.breakMinutes,
      graceMinutes: s.graceMinutes,
    };
  }
}
