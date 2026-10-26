import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AttendanceCorrectionInput,
  AttendanceRecordDto,
  AttendanceRegisterDto,
  AuthUser,
  ClockActionInput,
  ClockStaffDto,
  DailyAttendanceDto,
  LeaveType,
  MonthDayInput,
  PayComponent,
  PayType,
  RegisterCellDto,
  StaffDto,
  StaffInput,
  UpdateStaffInput,
} from "@stello/shared";
import {
  addDays,
  computeDayAttendance,
  daysBetween,
  DEFAULT_PAYROLL_CONFIG,
  istDateOf,
  PayrollConfigSchema,
  summariseMonth,
  type AttendanceRules,
  type PayrollConfig,
} from "@stello/shared";
import { Prisma } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";

export const N = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : typeof d === "number" ? d : Number(d));
export const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
export const dateStr = (d: Date) => d.toISOString().slice(0, 10);

const PIN_MAX_FAILS = 5;
const PIN_LOCK_MINUTES = 5;
// An open punch older than this is treated as a missed clock-out.
const STALE_OPEN_HOURS = 20;

type StaffRow = Prisma.StaffMemberGetPayload<object>;
type RecordRow = Prisma.AttendanceRecordGetPayload<object>;

/** The tenant's payroll settings (defaults when never saved). */
export async function loadPayrollConfig(prisma: Prisma.TransactionClient | PrismaService, tenantId: string): Promise<PayrollConfig> {
  const row = await prisma.payrollSetting.findFirst({ where: { tenantId } });
  if (!row) return DEFAULT_PAYROLL_CONFIG;
  const parsed = PayrollConfigSchema.safeParse(row.config);
  return parsed.success ? parsed.data : DEFAULT_PAYROLL_CONFIG;
}

export function rulesFromConfig(c: PayrollConfig): AttendanceRules {
  return {
    halfDayMinutes: Math.round(c.halfDayHours * 60),
    overtimeThresholdMinutes: c.overtimeThresholdMinutes,
    standardDayMinutes: Math.round(c.standardDayHours * 60),
  };
}

export const hasPerm = (user: AuthUser, p: string) => user.permissions.includes("*") || user.permissions.includes(p);

/**
 * Load everything the attendance maths needs for a set of staff over a date
 * range: rostered shifts, punches and approved leave, as per-day inputs.
 */
export async function loadAttendanceDays(
  prisma: Prisma.TransactionClient | PrismaService,
  tenantId: string,
  staff: { id: string; joiningDate: Date; exitDate: Date | null }[],
  from: string,
  to: string,
): Promise<Map<string, MonthDayInput[]>> {
  const ids = staff.map((s) => s.id);
  const [shifts, records, leaves] = await Promise.all([
    prisma.rosterShift.findMany({ where: { tenantId, staffId: { in: ids }, date: { gte: asDate(from), lte: asDate(to) } } }),
    // Punches are keyed by the IST date of the clock-in (an overnight shift belongs to its start day).
    prisma.attendanceRecord.findMany({ where: { tenantId, staffId: { in: ids }, date: { gte: asDate(from), lte: asDate(to) } } }),
    prisma.leaveRequest.findMany({
      where: { tenantId, staffId: { in: ids }, status: "APPROVED", fromDate: { lte: asDate(to) }, toDate: { gte: asDate(from) } },
    }),
  ]);
  const key = (staffId: string, date: string) => `${staffId}|${date}`;
  const shiftBy = new Map(shifts.map((s) => [key(s.staffId, dateStr(s.date)), s]));
  const punchBy = new Map<string, RecordRow[]>();
  for (const r of records) {
    const k = key(r.staffId, dateStr(r.date));
    punchBy.set(k, [...(punchBy.get(k) ?? []), r]);
  }
  const leaveBy = new Map<string, { type: LeaveType; fraction: number }>();
  for (const l of leaves) {
    for (let d = dateStr(l.fromDate); d <= dateStr(l.toDate); d = addDays(d, 1)) {
      leaveBy.set(key(l.staffId, d), { type: l.type as LeaveType, fraction: l.halfDay ? 0.5 : 1 });
    }
  }
  const out = new Map<string, MonthDayInput[]>();
  const n = daysBetween(from, to);
  for (const s of staff) {
    const join = dateStr(s.joiningDate);
    const exit = s.exitDate ? dateStr(s.exitDate) : null;
    const days: MonthDayInput[] = [];
    for (let i = 0; i <= n; i++) {
      const date = addDays(from, i);
      const sh = shiftBy.get(key(s.id, date));
      days.push({
        date,
        shift: sh ? { startTime: sh.startTime, endTime: sh.endTime, breakMinutes: sh.breakMinutes, graceMinutes: sh.graceMinutes } : null,
        punches: (punchBy.get(key(s.id, date)) ?? []).map((r) => ({ clockIn: r.clockIn, clockOut: r.clockOut, breakMinutes: r.breakMinutes })),
        leave: leaveBy.get(key(s.id, date)) ?? null,
        employed: date >= join && (!exit || date <= exit),
      });
    }
    out.set(s.id, days);
  }
  return out;
}

@Injectable()
export class StaffService {
  constructor(private readonly prisma: PrismaService) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  async requireStaff(user: AuthUser, id: string): Promise<StaffRow> {
    const s = await this.prisma.staffMember.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!s || !user.outletIds.includes(s.outletId)) throw new NotFoundException("Staff member not found");
    return s;
  }

  // ---------- Profiles ----------

  async list(user: AuthUser, outletId: string): Promise<StaffDto[]> {
    this.assertOutlet(user, outletId);
    const rows = await this.prisma.staffMember.findMany({
      where: { tenantId: user.tenantId, outletId },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
    });
    const userIds = rows.map((r) => r.userId).filter((x): x is string => !!x);
    const users = userIds.length
      ? await this.prisma.user.findMany({ where: { tenantId: user.tenantId, id: { in: userIds } }, select: { id: true, email: true } })
      : [];
    const emails = new Map(users.map((u) => [u.id, u.email]));
    return rows.map((r) => this.toDto(r, r.userId ? emails.get(r.userId) ?? null : null));
  }

  /** Logins in this tenant that are not yet linked to a staff profile. */
  async linkableUsers(user: AuthUser): Promise<{ id: string; name: string; email: string }[]> {
    const linked = await this.prisma.staffMember.findMany({ where: { tenantId: user.tenantId, userId: { not: null } }, select: { userId: true } });
    const taken = new Set(linked.map((l) => l.userId));
    const users = await this.prisma.user.findMany({ where: { tenantId: user.tenantId, isActive: true }, select: { id: true, name: true, email: true }, orderBy: { name: "asc" } });
    return users.filter((u) => !taken.has(u.id));
  }

  private async validateLinks(user: AuthUser, input: UpdateStaffInput, selfId?: string) {
    if (input.outletId) this.assertOutlet(user, input.outletId);
    if (input.userId) {
      const u = await this.prisma.user.findFirst({ where: { id: input.userId, tenantId: user.tenantId } });
      if (!u) throw new BadRequestException("Linked login not found");
      const other = await this.prisma.staffMember.findFirst({ where: { tenantId: user.tenantId, userId: input.userId, NOT: selfId ? { id: selfId } : undefined } });
      if (other) throw new BadRequestException("That login is already linked to another staff profile");
    }
    if (input.employeeCode) {
      const dup = await this.prisma.staffMember.findFirst({
        where: { tenantId: user.tenantId, employeeCode: input.employeeCode, NOT: selfId ? { id: selfId } : undefined },
      });
      if (dup) throw new BadRequestException("Employee code already in use");
    }
  }

  async create(user: AuthUser, input: StaffInput): Promise<StaffDto> {
    await this.validateLinks(user, input);
    const s = await this.prisma.staffMember.create({
      data: {
        tenantId: user.tenantId,
        outletId: input.outletId,
        userId: input.userId ?? null,
        employeeCode: input.employeeCode,
        name: input.name,
        phone: input.phone ?? null,
        designation: input.designation ?? null,
        joiningDate: asDate(input.joiningDate),
        exitDate: input.exitDate ? asDate(input.exitDate) : null,
        payType: input.payType,
        payRate: input.payRate,
        allowances: input.allowances,
        deductions: input.deductions,
        pfApplicable: input.pfApplicable,
        esiApplicable: input.esiApplicable,
        ptApplicable: input.ptApplicable,
        overtimeEligible: input.overtimeEligible,
        isActive: input.isActive,
      },
    });
    return this.toDto(s, null);
  }

  async update(user: AuthUser, id: string, input: UpdateStaffInput): Promise<StaffDto> {
    await this.requireStaff(user, id);
    await this.validateLinks(user, input, id);
    const s = await this.prisma.staffMember.update({
      where: { id },
      data: {
        outletId: input.outletId,
        userId: input.userId,
        employeeCode: input.employeeCode,
        name: input.name,
        phone: input.phone,
        designation: input.designation,
        joiningDate: input.joiningDate ? asDate(input.joiningDate) : undefined,
        exitDate: input.exitDate === undefined ? undefined : input.exitDate ? asDate(input.exitDate) : null,
        payType: input.payType,
        payRate: input.payRate,
        allowances: input.allowances,
        deductions: input.deductions,
        pfApplicable: input.pfApplicable,
        esiApplicable: input.esiApplicable,
        ptApplicable: input.ptApplicable,
        overtimeEligible: input.overtimeEligible,
        isActive: input.isActive,
      },
    });
    return this.toDto(s, null);
  }

  async setPin(user: AuthUser, id: string, pin: string): Promise<{ ok: true }> {
    await this.requireStaff(user, id);
    const pinHash = await bcrypt.hash(pin, 10);
    await this.prisma.staffMember.update({ where: { id }, data: { pinHash, pinFailedCount: 0, pinLockedUntil: null } });
    await this.prisma.auditLog.create({
      data: { tenantId: user.tenantId, userId: user.id, action: "STAFF_PIN_SET", entity: "staff", entityId: id },
    });
    return { ok: true };
  }

  // ---------- POS clock ----------

  async clockBoard(user: AuthUser, outletId: string): Promise<ClockStaffDto[]> {
    this.assertOutlet(user, outletId);
    const staff = await this.prisma.staffMember.findMany({
      where: { tenantId: user.tenantId, outletId, isActive: true, pinHash: { not: null } },
      orderBy: { name: "asc" },
    });
    const open = await this.prisma.attendanceRecord.findMany({
      where: { tenantId: user.tenantId, staffId: { in: staff.map((s) => s.id) }, clockOut: null },
      orderBy: { clockIn: "desc" },
    });
    const openBy = new Map<string, RecordRow>();
    for (const r of open) if (!openBy.has(r.staffId)) openBy.set(r.staffId, r);
    return staff.map((s) => {
      const r = openBy.get(s.id);
      return {
        id: s.id,
        name: s.name,
        designation: s.designation,
        status: !r ? "OUT" : r.breakStartedAt ? "ON_BREAK" : "IN",
        since: r ? (r.breakStartedAt ?? r.clockIn).toISOString() : null,
      };
    });
  }

  /**
   * PIN clock action on a POS terminal. The staff row is locked so two taps
   * cannot open two punches. A wrong PIN is counted (and the profile locked
   * after repeated failures) in a committed transaction before the error is
   * raised, so failures cannot be retried for free.
   */
  async clock(user: AuthUser, outletId: string, input: ClockActionInput, now = new Date()): Promise<ClockStaffDto> {
    this.assertOutlet(user, outletId);
    const result = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM staff_members WHERE id = ${input.staffId} AND "tenantId" = ${user.tenantId}
        AND "outletId" = ${outletId} FOR UPDATE`;
      if (!rows.length) throw new NotFoundException("Staff member not found");
      const s = await tx.staffMember.findFirstOrThrow({ where: { id: input.staffId, tenantId: user.tenantId } });
      if (!s.isActive) throw new BadRequestException("Staff member is inactive");
      if (!s.pinHash) throw new BadRequestException("No PIN set — ask a manager to set one");
      if (s.pinLockedUntil && s.pinLockedUntil > now) {
        return { error: `Too many wrong PINs — try again after ${Math.ceil((s.pinLockedUntil.getTime() - now.getTime()) / 60000)} min` };
      }
      if (!(await bcrypt.compare(input.pin, s.pinHash))) {
        const fails = s.pinFailedCount + 1;
        const lock = fails >= PIN_MAX_FAILS;
        await tx.staffMember.update({
          where: { id: s.id },
          data: { pinFailedCount: lock ? 0 : fails, pinLockedUntil: lock ? new Date(now.getTime() + PIN_LOCK_MINUTES * 60000) : null },
        });
        return { error: lock ? `Wrong PIN — locked for ${PIN_LOCK_MINUTES} min` : "Wrong PIN" };
      }
      if (s.pinFailedCount > 0) await tx.staffMember.update({ where: { id: s.id }, data: { pinFailedCount: 0 } });

      let open = await tx.attendanceRecord.findFirst({
        where: { tenantId: user.tenantId, staffId: s.id, clockOut: null },
        orderBy: { clockIn: "desc" },
      });
      if (open && now.getTime() - open.clockIn.getTime() > STALE_OPEN_HOURS * 3600000) {
        // Missed clock-out: close at zero worked time and flag for a manager to correct.
        await tx.attendanceRecord.update({
          where: { id: open.id },
          data: { clockOut: open.clockIn, breakStartedAt: null, source: "CORRECTED", correctionReason: "Auto-closed: missed clock-out" },
        });
        open = null;
      }
      const breakMins = (r: RecordRow) => (r.breakStartedAt ? Math.floor((now.getTime() - r.breakStartedAt.getTime()) / 60000) : 0);
      switch (input.action) {
        case "IN":
          if (open) return { error: "Already clocked in" };
          await tx.attendanceRecord.create({
            data: { tenantId: user.tenantId, outletId, staffId: s.id, date: asDate(istDateOf(now)), clockIn: now, source: "PIN" },
          });
          break;
        case "OUT":
          if (!open) return { error: "Not clocked in" };
          await tx.attendanceRecord.update({
            where: { id: open.id },
            data: { clockOut: now, breakMinutes: open.breakMinutes + breakMins(open), breakStartedAt: null },
          });
          break;
        case "BREAK_START":
          if (!open) return { error: "Not clocked in" };
          if (open.breakStartedAt) return { error: "Already on a break" };
          await tx.attendanceRecord.update({ where: { id: open.id }, data: { breakStartedAt: now } });
          break;
        case "BREAK_END":
          if (!open?.breakStartedAt) return { error: "Not on a break" };
          await tx.attendanceRecord.update({
            where: { id: open.id },
            data: { breakMinutes: open.breakMinutes + breakMins(open), breakStartedAt: null },
          });
          break;
      }
      return { error: null };
    });
    if (result.error) throw new BadRequestException(result.error);
    const board = await this.clockBoard(user, outletId);
    return board.find((b) => b.id === input.staffId)!;
  }

  // ---------- Attendance views ----------

  async daily(user: AuthUser, outletId: string, date: string): Promise<DailyAttendanceDto> {
    this.assertOutlet(user, outletId);
    const rules = rulesFromConfig(await loadPayrollConfig(this.prisma, user.tenantId));
    const staff = await this.prisma.staffMember.findMany({ where: { tenantId: user.tenantId, outletId, isActive: true }, orderBy: { name: "asc" } });
    const [days, records] = await Promise.all([
      loadAttendanceDays(this.prisma, user.tenantId, staff, date, date),
      this.prisma.attendanceRecord.findMany({
        where: { tenantId: user.tenantId, staffId: { in: staff.map((s) => s.id) }, date: asDate(date) },
        orderBy: { clockIn: "asc" },
      }),
    ]);
    return {
      date,
      rows: staff.map((s) => {
        const d = days.get(s.id)![0];
        return {
          staffId: s.id,
          name: s.name,
          designation: s.designation,
          shift: d.shift ? { startTime: d.shift.startTime, endTime: d.shift.endTime } : null,
          records: records.filter((r) => r.staffId === s.id).map((r) => this.toRecordDto(r)),
          day: computeDayAttendance(date, d.shift, d.punches, rules),
        };
      }),
    };
  }

  async register(user: AuthUser, outletId: string, from: string, to: string): Promise<AttendanceRegisterDto> {
    this.assertOutlet(user, outletId);
    const rules = rulesFromConfig(await loadPayrollConfig(this.prisma, user.tenantId));
    if (to < from || daysBetween(from, to) > 62) throw new BadRequestException("Register range must be 1–62 days");
    const staff = await this.prisma.staffMember.findMany({ where: { tenantId: user.tenantId, outletId }, orderBy: { name: "asc" } });
    const days = await loadAttendanceDays(this.prisma, user.tenantId, staff, from, to);
    const rows = staff
      .map((s) => {
        const list = days.get(s.id)!;
        if (!s.isActive && list.every((d) => d.punches.length === 0)) return null;
        const cells: RegisterCellDto[] = list.map((d) => {
          const a = computeDayAttendance(d.date, d.shift, d.punches, rules);
          const onLeave = !!d.leave && (a.status === "ABSENT" || a.status === "OFF");
          return {
            date: d.date,
            status: onLeave ? "LEAVE" : a.status,
            workedMinutes: a.workedMinutes,
            lateMinutes: a.lateMinutes,
            overtimeMinutes: a.overtimeMinutes,
            leaveType: d.leave?.type ?? null,
          };
        });
        return { staffId: s.id, name: s.name, employeeCode: s.employeeCode, days: cells, totals: summariseMonth(list, rules) };
      })
      .filter((r): r is NonNullable<typeof r> => !!r);
    return { from, to, rows };
  }

  /** Manual add/correction of a punch. Always audited with a reason; locked once payroll is finalised. */
  async correct(user: AuthUser, outletId: string, input: AttendanceCorrectionInput): Promise<AttendanceRecordDto> {
    this.assertOutlet(user, outletId);
    const clockIn = new Date(input.clockIn);
    const clockOut = input.clockOut ? new Date(input.clockOut) : null;
    if (clockOut && clockOut <= clockIn) throw new BadRequestException("Clock-out must be after clock-in");
    if (clockIn > new Date() || (clockOut && clockOut > new Date())) throw new BadRequestException("Times cannot be in the future");
    if (clockOut && clockOut.getTime() - clockIn.getTime() > 24 * 3600000) throw new BadRequestException("A punch cannot exceed 24 hours");
    const staff = await this.prisma.staffMember.findFirst({ where: { id: input.staffId, tenantId: user.tenantId, outletId } });
    if (!staff) throw new NotFoundException("Staff member not found");
    const date = istDateOf(clockIn);
    const record = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM staff_members WHERE id = ${staff.id} FOR UPDATE`;
      if (!locked.length) throw new NotFoundException("Staff member not found");
      const months = new Set([date.slice(0, 7)]);
      let before: RecordRow | null = null;
      if (input.recordId) {
        before = await tx.attendanceRecord.findFirst({ where: { id: input.recordId, tenantId: user.tenantId, staffId: staff.id } });
        if (!before) throw new NotFoundException("Attendance record not found");
        months.add(dateStr(before.date).slice(0, 7));
      }
      const finalised = await tx.payrollRun.findFirst({
        where: { tenantId: user.tenantId, outletId, month: { in: [...months] }, status: "FINALISED" },
      });
      if (finalised) throw new BadRequestException(`Payroll for ${finalised.month} is finalised — attendance is locked`);
      if (!clockOut) {
        const otherOpen = await tx.attendanceRecord.findFirst({
          where: { tenantId: user.tenantId, staffId: staff.id, clockOut: null, NOT: input.recordId ? { id: input.recordId } : undefined },
        });
        if (otherOpen) throw new BadRequestException("Staff member already has an open punch");
      }
      const data = {
        date: asDate(date),
        clockIn,
        clockOut,
        breakMinutes: input.breakMinutes,
        breakStartedAt: null,
        correctionReason: input.reason,
        correctedById: user.id,
      };
      const saved = before
        ? await tx.attendanceRecord.update({ where: { id: before.id }, data: { ...data, source: "CORRECTED" } })
        : await tx.attendanceRecord.create({ data: { ...data, tenantId: user.tenantId, outletId, staffId: staff.id, source: "MANUAL" } });
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          action: before ? "ATTENDANCE_CORRECTED" : "ATTENDANCE_ADDED",
          entity: "attendance",
          entityId: saved.id,
          data: {
            staffId: staff.id,
            reason: input.reason,
            before: before ? { clockIn: before.clockIn.toISOString(), clockOut: before.clockOut?.toISOString() ?? null, breakMinutes: before.breakMinutes } : null,
            after: { clockIn: clockIn.toISOString(), clockOut: clockOut?.toISOString() ?? null, breakMinutes: input.breakMinutes },
          },
        },
      });
      return saved;
    });
    return this.toRecordDto(record);
  }

  // ---------- mappers ----------

  toRecordDto(r: RecordRow): AttendanceRecordDto {
    return {
      id: r.id,
      staffId: r.staffId,
      date: dateStr(r.date),
      clockIn: r.clockIn.toISOString(),
      clockOut: r.clockOut?.toISOString() ?? null,
      breakMinutes: r.breakMinutes,
      onBreak: !!r.breakStartedAt,
      source: r.source as AttendanceRecordDto["source"],
      correctionReason: r.correctionReason,
    };
  }

  toDto(s: StaffRow, userEmail: string | null): StaffDto {
    return {
      id: s.id,
      outletId: s.outletId,
      employeeCode: s.employeeCode,
      name: s.name,
      phone: s.phone,
      designation: s.designation,
      joiningDate: dateStr(s.joiningDate),
      exitDate: s.exitDate ? dateStr(s.exitDate) : null,
      userId: s.userId,
      userEmail,
      payType: s.payType as PayType,
      payRate: N(s.payRate),
      allowances: (s.allowances as PayComponent[] | null) ?? [],
      deductions: (s.deductions as PayComponent[] | null) ?? [],
      pfApplicable: s.pfApplicable,
      esiApplicable: s.esiApplicable,
      ptApplicable: s.ptApplicable,
      overtimeEligible: s.overtimeEligible,
      isActive: s.isActive,
      hasPin: !!s.pinHash,
    };
  }
}

