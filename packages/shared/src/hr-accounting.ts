import { z } from "zod";

// Staff / HR, payroll, accounting (expenses, P&L, day book) and gift cards.
//
// The pure functions here (attendance math, month summaries, payslip maths) are
// the single source of the formulas so the API, the dashboard previews and the
// tests all agree to the paisa.

// ---------- Time helpers (India Standard Time) ----------

// India has no DST, so business dates are derived with a fixed +05:30 offset —
// independent of the server's own timezone.
export const IST_OFFSET_MIN = 330;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The IST calendar date ("YYYY-MM-DD") an instant falls on. */
export function istDateOf(d: Date): string {
  const s = new Date(d.getTime() + IST_OFFSET_MIN * 60000);
  return `${s.getUTCFullYear()}-${pad2(s.getUTCMonth() + 1)}-${pad2(s.getUTCDate())}`;
}

/** The instant of a wall-clock "HH:MM" on an IST calendar date. */
export function istAt(date: string, hhmm = "00:00"): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - IST_OFFSET_MIN * 60000);
}

/** Inclusive IST day range as instants, for `createdAt` filters. */
export function istRange(from: string, to: string): { gte: Date; lt: Date } {
  return { gte: istAt(from), lt: istAt(addDays(to, 1)) };
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Every date of a "YYYY-MM" month. */
export function monthDates(month: string): string[] {
  return Array.from({ length: daysInMonth(month) }, (_, i) => `${month}-${pad2(i + 1)}`);
}

/** Day of week (0 = Sunday) for a calendar date. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24h)");
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const MONTH = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM");
const MONEY = z.number().min(0).multipleOf(0.01);

// ---------- Staff profiles ----------

export const PayType = z.enum(["MONTHLY", "DAILY", "HOURLY"]);
export type PayType = z.infer<typeof PayType>;

const PayComponentSchema = z.object({ name: z.string().min(1).max(40), amount: MONEY });
export type PayComponent = z.infer<typeof PayComponentSchema>;

export const StaffInputSchema = z.object({
  outletId: z.string().min(1),
  employeeCode: z.string().min(1).max(20),
  name: z.string().min(1).max(80),
  phone: z.string().max(20).nullable().optional(),
  designation: z.string().max(60).nullable().optional(),
  joiningDate: DATE,
  exitDate: DATE.nullable().optional(),
  userId: z.string().nullable().optional(), // link a login (optional — helpers may have none)
  payType: PayType.default("MONTHLY"),
  payRate: MONEY, // monthly salary / day wage / hourly rate (rupees)
  allowances: z.array(PayComponentSchema).max(10).default([]),
  deductions: z.array(PayComponentSchema).max(10).default([]),
  pfApplicable: z.boolean().default(false),
  esiApplicable: z.boolean().default(false),
  ptApplicable: z.boolean().default(false),
  overtimeEligible: z.boolean().default(true),
  isActive: z.boolean().default(true),
});
export type StaffInput = z.infer<typeof StaffInputSchema>;
export const UpdateStaffSchema = StaffInputSchema.partial();
export type UpdateStaffInput = z.infer<typeof UpdateStaffSchema>;

export const SetPinSchema = z.object({ pin: z.string().regex(/^\d{4,6}$/, "PIN must be 4–6 digits") });
export type SetPinInput = z.infer<typeof SetPinSchema>;

export interface StaffDto {
  id: string;
  outletId: string;
  employeeCode: string;
  name: string;
  phone: string | null;
  designation: string | null;
  joiningDate: string;
  exitDate: string | null;
  userId: string | null;
  userEmail: string | null;
  payType: PayType;
  payRate: number;
  allowances: PayComponent[];
  deductions: PayComponent[];
  pfApplicable: boolean;
  esiApplicable: boolean;
  ptApplicable: boolean;
  overtimeEligible: boolean;
  isActive: boolean;
  hasPin: boolean;
}

/** What the POS clock screen sees: no pay data. */
export interface ClockStaffDto {
  id: string;
  name: string;
  designation: string | null;
  status: "OUT" | "IN" | "ON_BREAK";
  since: string | null;
}

// ---------- Attendance ----------

export const ClockActionSchema = z.object({
  staffId: z.string().min(1),
  pin: z.string().regex(/^\d{4,6}$/),
  action: z.enum(["IN", "OUT", "BREAK_START", "BREAK_END"]),
});
export type ClockActionInput = z.infer<typeof ClockActionSchema>;

export const AttendanceCorrectionSchema = z.object({
  staffId: z.string().min(1),
  recordId: z.string().nullable().optional(), // null = add a missing record
  clockIn: z.string().datetime({ offset: true }),
  clockOut: z.string().datetime({ offset: true }).nullable().optional(),
  breakMinutes: z.number().int().min(0).max(600).default(0),
  reason: z.string().min(3).max(200),
});
export type AttendanceCorrectionInput = z.infer<typeof AttendanceCorrectionSchema>;

export interface AttendanceRecordDto {
  id: string;
  staffId: string;
  date: string;
  clockIn: string;
  clockOut: string | null;
  breakMinutes: number;
  onBreak: boolean;
  source: "PIN" | "MANUAL" | "CORRECTED";
  correctionReason: string | null;
}

export type DayStatus = "PRESENT" | "HALF_DAY" | "ABSENT" | "OFF" | "OPEN" | "LEAVE";

export interface RegisterCellDto {
  date: string;
  status: DayStatus;
  workedMinutes: number;
  lateMinutes: number;
  overtimeMinutes: number;
  leaveType: LeaveType | null;
}

export interface AttendanceRegisterDto {
  from: string;
  to: string;
  rows: {
    staffId: string;
    name: string;
    employeeCode: string;
    days: RegisterCellDto[];
    totals: MonthAttendanceSummary;
  }[];
}

export interface DailyAttendanceDto {
  date: string;
  rows: {
    staffId: string;
    name: string;
    designation: string | null;
    shift: { startTime: string; endTime: string } | null;
    records: AttendanceRecordDto[];
    day: DayAttendance;
  }[];
}

// ---------- Shifts / roster ----------

export const ShiftTemplateSchema = z.object({
  name: z.string().min(1).max(40),
  startTime: HHMM,
  endTime: HHMM,
  breakMinutes: z.number().int().min(0).max(240).default(30),
  graceMinutes: z.number().int().min(0).max(120).default(10),
});
export type ShiftTemplateInput = z.infer<typeof ShiftTemplateSchema>;

export interface ShiftTemplateDto extends ShiftTemplateInput {
  id: string;
}

export const RosterAssignSchema = z.object({
  // One entry per staff per date; templateId null clears the day (weekly off).
  entries: z
    .array(
      z.object({
        staffId: z.string().min(1),
        date: DATE,
        templateId: z.string().nullable(),
      }),
    )
    .min(1)
    .max(500),
});
export type RosterAssignInput = z.infer<typeof RosterAssignSchema>;

export interface RosterShiftDto {
  id: string;
  staffId: string;
  date: string;
  templateId: string | null;
  templateName: string | null;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  graceMinutes: number;
}

export interface RosterWeekDto {
  weekStart: string;
  dates: string[];
  staff: { id: string; name: string; designation: string | null }[];
  shifts: RosterShiftDto[];
  leaves: { staffId: string; date: string; type: LeaveType }[];
}

export const SwapRequestSchema = z.object({
  fromShiftId: z.string().min(1),
  toStaffId: z.string().min(1),
  toShiftId: z.string().nullable().optional(), // null = toStaff covers (no swap back)
  reason: z.string().max(200).optional(),
});
export type SwapRequestInput = z.infer<typeof SwapRequestSchema>;

export interface SwapRequestDto {
  id: string;
  fromShift: RosterShiftDto & { staffName: string };
  toStaffId: string;
  toStaffName: string;
  toShift: (RosterShiftDto & { staffName: string }) | null;
  reason: string | null;
  status: RequestStatus;
  createdAt: string;
}

// ---------- Leave ----------

export const LeaveType = z.enum(["CASUAL", "SICK", "EARNED", "UNPAID"]);
export type LeaveType = z.infer<typeof LeaveType>;
export type RequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

export const LeaveRequestSchema = z
  .object({
    staffId: z.string().min(1),
    type: LeaveType,
    fromDate: DATE,
    toDate: DATE,
    halfDay: z.boolean().default(false),
    reason: z.string().max(200).optional(),
  })
  .refine((v) => v.toDate >= v.fromDate, { message: "toDate must be on/after fromDate", path: ["toDate"] })
  .refine((v) => !v.halfDay || v.fromDate === v.toDate, { message: "A half day covers a single date", path: ["halfDay"] });
export type LeaveRequestInput = z.infer<typeof LeaveRequestSchema>;

export const DecisionSchema = z.object({
  approve: z.boolean(),
  note: z.string().max(200).optional(),
});
export type DecisionInput = z.infer<typeof DecisionSchema>;

export const LeaveBalanceSchema = z.object({
  staffId: z.string().min(1),
  year: z.number().int().min(2000).max(2100),
  type: LeaveType.exclude(["UNPAID"]),
  allotted: z.number().min(0).max(366).multipleOf(0.5),
});
export type LeaveBalanceInput = z.infer<typeof LeaveBalanceSchema>;

export interface LeaveRequestDto {
  id: string;
  staffId: string;
  staffName: string;
  type: LeaveType;
  fromDate: string;
  toDate: string;
  days: number;
  halfDay: boolean;
  reason: string | null;
  status: RequestStatus;
  decisionNote: string | null;
  createdAt: string;
}

export interface LeaveBalanceDto {
  staffId: string;
  staffName: string;
  year: number;
  balances: { type: Exclude<LeaveType, "UNPAID">; allotted: number; used: number; available: number }[];
}

/** Calendar days a leave covers (0.5 for a half day). */
export function leaveDays(fromDate: string, toDate: string, halfDay: boolean): number {
  if (halfDay) return 0.5;
  return daysBetween(fromDate, toDate) + 1;
}

// ---------- Attendance maths ----------

export interface ShiftSpec {
  startTime: string; // "HH:MM" IST
  endTime: string; // earlier than start = crosses midnight
  breakMinutes: number;
  graceMinutes: number;
}

export interface Punch {
  clockIn: Date;
  clockOut: Date | null;
  breakMinutes: number;
}

export interface AttendanceRules {
  halfDayMinutes: number; // worked below this on a day = half day
  overtimeThresholdMinutes: number; // overtime below this is ignored
  standardDayMinutes: number; // a working day when no shift is rostered
}

export const DEFAULT_ATTENDANCE_RULES: AttendanceRules = {
  halfDayMinutes: 240,
  overtimeThresholdMinutes: 30,
  standardDayMinutes: 480,
};

export interface DayAttendance {
  status: Exclude<DayStatus, "LEAVE">;
  workedMinutes: number;
  scheduledMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
}

const minutes = (ms: number) => Math.floor(ms / 60000);

/**
 * One day's attendance against its rostered shift. Worked time is the sum of
 * closed punches less their breaks; an open punch makes the day OPEN (not yet
 * counted). Late = minutes after shift start once beyond the grace period;
 * overtime = worked beyond the scheduled (shift less break) time, counted only
 * once it reaches the threshold.
 */
export function computeDayAttendance(
  date: string,
  shift: ShiftSpec | null,
  punches: Punch[],
  rules: AttendanceRules = DEFAULT_ATTENDANCE_RULES,
): DayAttendance {
  let scheduledMinutes = rules.standardDayMinutes;
  let shiftStart: Date | null = null;
  let shiftEnd: Date | null = null;
  if (shift) {
    shiftStart = istAt(date, shift.startTime);
    shiftEnd = istAt(date, shift.endTime);
    if (shiftEnd <= shiftStart) shiftEnd = new Date(shiftEnd.getTime() + 86400000);
    scheduledMinutes = Math.max(0, minutes(shiftEnd.getTime() - shiftStart.getTime()) - shift.breakMinutes);
  }
  const empty = { workedMinutes: 0, scheduledMinutes, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0 };
  if (punches.length === 0) return { status: shift ? "ABSENT" : "OFF", ...empty };

  const sorted = [...punches].sort((a, b) => a.clockIn.getTime() - b.clockIn.getTime());
  let worked = 0;
  for (const p of sorted) {
    if (!p.clockOut) continue;
    worked += Math.max(0, minutes(p.clockOut.getTime() - p.clockIn.getTime()) - p.breakMinutes);
  }
  const open = sorted.some((p) => !p.clockOut);

  let late = 0;
  let early = 0;
  if (shift && shiftStart && shiftEnd) {
    const lateBy = minutes(sorted[0].clockIn.getTime() - shiftStart.getTime());
    late = lateBy > shift.graceMinutes ? lateBy : 0;
    if (!open) {
      const lastOut = Math.max(...sorted.map((p) => p.clockOut!.getTime()));
      early = Math.max(0, minutes(shiftEnd.getTime() - lastOut));
    }
  }
  const extra = worked - scheduledMinutes;
  const overtime = extra >= rules.overtimeThresholdMinutes ? extra : 0;
  const status: DayAttendance["status"] = open ? "OPEN" : worked < rules.halfDayMinutes ? "HALF_DAY" : "PRESENT";
  return { status, workedMinutes: worked, scheduledMinutes, lateMinutes: late, earlyLeaveMinutes: early, overtimeMinutes: overtime };
}

export interface MonthDayInput {
  date: string;
  shift: ShiftSpec | null;
  punches: Punch[];
  /** Approved leave on this date (fraction 1 or 0.5). */
  leave: { type: LeaveType; fraction: number } | null;
  /** False before joining / after exit — the day is not payable. */
  employed: boolean;
}

export interface MonthAttendanceSummary {
  presentDays: number; // full = 1, half = 0.5 (open punches count as present)
  absentDays: number; // rostered, not attended and not on paid leave
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  lopDays: number; // loss-of-pay days for monthly salaries
  workedMinutes: number;
  overtimeMinutes: number;
  lateDays: number;
  lateMinutes: number;
}

/**
 * Roll a month of days into payroll inputs. A rostered day must be covered by
 * attendance and/or paid leave; any uncovered fraction is loss-of-pay. Days
 * without a rostered shift are weekly offs (paid), and work done on them still
 * counts as presence/overtime. Days outside employment are loss-of-pay.
 */
export function summariseMonth(days: MonthDayInput[], rules: AttendanceRules = DEFAULT_ATTENDANCE_RULES): MonthAttendanceSummary {
  const s: MonthAttendanceSummary = {
    presentDays: 0,
    absentDays: 0,
    paidLeaveDays: 0,
    unpaidLeaveDays: 0,
    lopDays: 0,
    workedMinutes: 0,
    overtimeMinutes: 0,
    lateDays: 0,
    lateMinutes: 0,
  };
  for (const d of days) {
    if (!d.employed) {
      s.lopDays += 1;
      continue;
    }
    const day = computeDayAttendance(d.date, d.shift, d.punches, rules);
    const attended = day.status === "PRESENT" || day.status === "OPEN" ? 1 : day.status === "HALF_DAY" ? 0.5 : 0;
    s.presentDays += attended;
    s.workedMinutes += day.workedMinutes;
    s.overtimeMinutes += day.overtimeMinutes;
    if (day.lateMinutes > 0) {
      s.lateDays += 1;
      s.lateMinutes += day.lateMinutes;
    }
    const paidLeave = d.leave && d.leave.type !== "UNPAID" ? d.leave.fraction : 0;
    const unpaidLeave = d.leave && d.leave.type === "UNPAID" ? d.leave.fraction : 0;
    if (d.shift) {
      // Leave only counts where the day was not already worked.
      const usedPaid = Math.min(paidLeave, 1 - attended);
      s.paidLeaveDays += usedPaid;
      s.unpaidLeaveDays += Math.min(unpaidLeave, 1 - attended - usedPaid);
      const uncovered = 1 - attended - usedPaid;
      s.lopDays += uncovered;
      s.absentDays += Math.max(0, uncovered - unpaidLeave);
    }
  }
  return s;
}

// ---------- Payroll ----------

/**
 * Statutory components are CONFIGURABLE. The defaults below are illustrative
 * starting points only — rates, ceilings, thresholds and professional-tax slabs
 * vary by state and change over time; verify them with your accountant before
 * finalising a payroll.
 */
export const PayrollConfigSchema = z.object({
  monthlyBasis: z.union([z.literal("CALENDAR"), z.literal(26), z.literal(30)]).default("CALENDAR"),
  standardDayHours: z.number().min(1).max(16).default(8),
  halfDayHours: z.number().min(0).max(12).default(4),
  overtimeMultiplier: z.number().min(1).max(4).default(2),
  overtimeThresholdMinutes: z.number().int().min(0).max(240).default(30),
  payPaidLeaveForWageStaff: z.boolean().default(true),
  pf: z
    .object({
      enabled: z.boolean().default(true),
      employeeRate: z.number().min(0).max(100).default(12),
      employerRate: z.number().min(0).max(100).default(12),
      wageCeiling: z.number().min(0).default(15000), // 0 = no ceiling
    })
    .default({}),
  esi: z
    .object({
      enabled: z.boolean().default(true),
      employeeRate: z.number().min(0).max(100).default(0.75),
      employerRate: z.number().min(0).max(100).default(3.25),
      grossThreshold: z.number().min(0).default(21000),
    })
    .default({}),
  pt: z
    .object({
      enabled: z.boolean().default(true),
      // Ascending slabs on monthly gross; upTo null = and above.
      slabs: z
        .array(z.object({ upTo: z.number().min(0).nullable(), amount: z.number().min(0) }))
        .max(12)
        .default([
          { upTo: 24999, amount: 0 },
          { upTo: null, amount: 200 },
        ]),
    })
    .default({}),
});
export type PayrollConfig = z.infer<typeof PayrollConfigSchema>;
export const DEFAULT_PAYROLL_CONFIG: PayrollConfig = PayrollConfigSchema.parse({});

export const PayAdjustmentSchema = z.object({
  name: z.string().min(1).max(40),
  amount: MONEY,
  kind: z.enum(["EARNING", "DEDUCTION"]),
});
export type PayAdjustment = z.infer<typeof PayAdjustmentSchema>;

export interface PayInputs {
  payType: PayType;
  payRate: number;
  allowances: PayComponent[];
  deductions: PayComponent[];
  pfApplicable: boolean;
  esiApplicable: boolean;
  ptApplicable: boolean;
  overtimeEligible: boolean;
  daysInMonth: number;
  presentDays: number;
  paidLeaveDays: number;
  lopDays: number;
  workedMinutes: number;
  overtimeMinutes: number;
  /** Outstanding advance instalments due this month (capped to what pay allows). */
  advanceDue: number;
  adjustments: PayAdjustment[];
}

export interface PayLine {
  name: string;
  amount: number;
}

export interface PayslipCalc {
  payableDays: number;
  basic: number;
  overtimeHours: number;
  overtimePay: number;
  earnings: PayLine[]; // allowances + earning adjustments
  gross: number;
  pfEmployee: number;
  esiEmployee: number;
  professionalTax: number;
  advanceRecovery: number;
  otherDeductions: PayLine[];
  totalDeductions: number;
  net: number;
  pfEmployer: number;
  esiEmployer: number;
  warnings: string[];
}

const P = (rupees: number) => Math.round(rupees * 100);
const R = (paise: number) => Math.round(paise) / 100;
const wholeRupee = (paise: number) => Math.round(paise / 100) * 100;

/** Compute one payslip in integer paise. Statutory amounts round to whole rupees. */
export function computePayslip(input: PayInputs, config: PayrollConfig = DEFAULT_PAYROLL_CONFIG): PayslipCalc {
  const warnings: string[] = [];
  const rate = P(input.payRate);
  const dim = input.daysInMonth;
  const basisDays = config.monthlyBasis === "CALENDAR" ? dim : config.monthlyBasis;
  const lop = Math.min(input.lopDays, dim);
  const payableDays = Math.max(0, dim - lop);

  let basic = 0;
  let hourlyPaise = 0;
  let allowanceFactor = 1;
  if (input.payType === "MONTHLY") {
    const perDay = rate / basisDays;
    basic = Math.max(0, Math.round(rate - perDay * lop));
    allowanceFactor = rate > 0 ? basic / rate : 0;
    hourlyPaise = perDay / config.standardDayHours;
  } else if (input.payType === "DAILY") {
    const days = input.presentDays + (config.payPaidLeaveForWageStaff ? input.paidLeaveDays : 0);
    basic = Math.round(rate * days);
    hourlyPaise = rate / config.standardDayHours;
  } else {
    const regularMinutes = Math.max(0, input.workedMinutes - input.overtimeMinutes);
    const leaveHours = config.payPaidLeaveForWageStaff ? input.paidLeaveDays * config.standardDayHours : 0;
    basic = Math.round(rate * (regularMinutes / 60 + leaveHours));
    hourlyPaise = rate;
  }

  const otMinutes = input.overtimeEligible ? input.overtimeMinutes : 0;
  const overtimePay = Math.round(hourlyPaise * (otMinutes / 60) * config.overtimeMultiplier);

  const earnings: PayLine[] = [
    ...input.allowances.map((a) => ({ name: a.name, paise: Math.round(P(a.amount) * allowanceFactor) })),
    ...input.adjustments.filter((a) => a.kind === "EARNING").map((a) => ({ name: a.name, paise: P(a.amount) })),
  ].map((l) => ({ name: l.name, amount: l.paise }));
  const gross = basic + overtimePay + earnings.reduce((s, l) => s + l.amount, 0);

  let pfEmployee = 0;
  let pfEmployer = 0;
  if (config.pf.enabled && input.pfApplicable) {
    const ceiling = P(config.pf.wageCeiling);
    const pfWage = ceiling > 0 ? Math.min(basic, ceiling) : basic;
    pfEmployee = wholeRupee((pfWage * config.pf.employeeRate) / 100);
    pfEmployer = wholeRupee((pfWage * config.pf.employerRate) / 100);
  }
  let esiEmployee = 0;
  let esiEmployer = 0;
  if (config.esi.enabled && input.esiApplicable) {
    if (gross <= P(config.esi.grossThreshold)) {
      esiEmployee = wholeRupee((gross * config.esi.employeeRate) / 100);
      esiEmployer = wholeRupee((gross * config.esi.employerRate) / 100);
    } else {
      warnings.push("Gross above the ESI threshold — ESI not deducted");
    }
  }
  let professionalTax = 0;
  if (config.pt.enabled && input.ptApplicable) {
    const slab = config.pt.slabs.find((s) => s.upTo == null || gross <= P(s.upTo));
    professionalTax = slab ? P(slab.amount) : 0;
  }

  const otherDeductions: PayLine[] = [
    ...input.deductions.map((d) => ({ name: d.name, amount: P(d.amount) })),
    ...input.adjustments.filter((a) => a.kind === "DEDUCTION").map((a) => ({ name: a.name, amount: P(a.amount) })),
  ];
  const fixed = pfEmployee + esiEmployee + professionalTax + otherDeductions.reduce((s, l) => s + l.amount, 0);
  const advanceRecovery = Math.max(0, Math.min(P(input.advanceDue), gross - fixed));
  if (advanceRecovery < P(input.advanceDue)) warnings.push("Advance recovery reduced to keep net pay non-negative");
  const totalDeductions = fixed + advanceRecovery;
  const net = gross - totalDeductions;
  if (net < 0) warnings.push("Deductions exceed gross pay");

  return {
    payableDays,
    basic: R(basic),
    overtimeHours: Math.round((otMinutes / 60) * 100) / 100,
    overtimePay: R(overtimePay),
    earnings: earnings.map((l) => ({ name: l.name, amount: R(l.amount) })),
    gross: R(gross),
    pfEmployee: R(pfEmployee),
    esiEmployee: R(esiEmployee),
    professionalTax: R(professionalTax),
    advanceRecovery: R(advanceRecovery),
    otherDeductions: otherDeductions.map((l) => ({ name: l.name, amount: R(l.amount) })),
    totalDeductions: R(totalDeductions),
    net: R(net),
    pfEmployer: R(pfEmployer),
    esiEmployer: R(esiEmployer),
    warnings,
  };
}

export const CreatePayrollRunSchema = z.object({ month: MONTH });
export type CreatePayrollRunInput = z.infer<typeof CreatePayrollRunSchema>;

export const UpdatePayslipSchema = z.object({
  lopDays: z.number().min(0).max(31).multipleOf(0.5).optional(),
  overtimeMinutes: z.number().int().min(0).max(31 * 24 * 60).optional(),
  adjustments: z.array(PayAdjustmentSchema).max(10).optional(),
  note: z.string().max(200).nullable().optional(),
});
export type UpdatePayslipInput = z.infer<typeof UpdatePayslipSchema>;

export interface PayslipDto {
  id: string;
  staffId: string;
  staffName: string;
  employeeCode: string;
  designation: string | null;
  payType: PayType;
  payRate: number;
  daysInMonth: number;
  attendance: MonthAttendanceSummary;
  lopDays: number;
  overtimeMinutes: number;
  adjustments: PayAdjustment[];
  calc: PayslipCalc;
  note: string | null;
}

export interface PayrollRunDto {
  id: string;
  outletId: string;
  outletName: string;
  month: string;
  status: "DRAFT" | "FINALISED";
  config: PayrollConfig;
  totals: { gross: number; deductions: number; net: number; employerCost: number };
  finalisedAt: string | null;
  payslips: PayslipDto[];
}

export interface PayrollRunRowDto {
  id: string;
  month: string;
  status: "DRAFT" | "FINALISED";
  staffCount: number;
  net: number;
  employerCost: number;
}

export const SalaryAdvanceSchema = z.object({
  staffId: z.string().min(1),
  amount: MONEY.refine((n) => n > 0, "Amount must be positive"),
  monthlyRecovery: MONEY.refine((n) => n > 0, "Recovery must be positive"),
  givenOn: DATE,
  paidFrom: z.enum(["CASH_DRAWER", "BANK"]).default("BANK"),
  note: z.string().max(200).optional(),
});
export type SalaryAdvanceInput = z.infer<typeof SalaryAdvanceSchema>;

export interface SalaryAdvanceDto {
  id: string;
  staffId: string;
  staffName: string;
  amount: number;
  monthlyRecovery: number;
  recovered: number;
  outstanding: number;
  givenOn: string;
  paidFrom: "CASH_DRAWER" | "BANK";
  status: "OPEN" | "CLOSED";
  note: string | null;
}

export interface StaffSalesRowDto {
  userId: string;
  name: string;
  staffId: string | null;
  ordersTaken: number;
  salesTaken: number; // net of tax, orders this user created
  avgTicket: number;
  itemsSold: number;
  billsSettled: number;
  amountSettled: number; // totals of bills this user settled
}

// ---------- Accounting: expenses, P&L, day book ----------

export const ExpensePaidFrom = z.enum(["CASH_DRAWER", "BANK", "UPI", "CARD", "PAYABLE"]);
export type ExpensePaidFrom = z.infer<typeof ExpensePaidFrom>;

export const ExpenseCategorySchema = z.object({
  name: z.string().min(1).max(40),
  ledgerName: z.string().max(60).nullable().optional(), // Tally ledger; defaults to the name
  isActive: z.boolean().default(true),
});
export type ExpenseCategoryInput = z.infer<typeof ExpenseCategorySchema>;

export interface ExpenseCategoryDto {
  id: string;
  name: string;
  ledgerName: string | null;
  isActive: boolean;
}

export const ExpenseSchema = z
  .object({
    categoryId: z.string().min(1),
    date: DATE,
    taxableAmount: MONEY,
    cgst: MONEY.default(0),
    sgst: MONEY.default(0),
    igst: MONEY.default(0),
    itcEligible: z.boolean().default(true), // GST input credit claimable
    vendorName: z.string().max(80).nullable().optional(),
    vendorGstin: z.string().max(15).nullable().optional(),
    invoiceNumber: z.string().max(40).nullable().optional(),
    paidFrom: ExpensePaidFrom,
    reference: z.string().max(60).nullable().optional(),
    note: z.string().max(200).nullable().optional(),
    attachmentUrl: z.string().url().max(500).nullable().optional(),
  })
  .refine((v) => v.taxableAmount + v.cgst + v.sgst + v.igst > 0, { message: "Amount must be positive", path: ["taxableAmount"] });
export type ExpenseInput = z.infer<typeof ExpenseSchema>;

export interface ExpenseDto {
  id: string;
  categoryId: string;
  categoryName: string;
  date: string;
  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  itcEligible: boolean;
  vendorName: string | null;
  vendorGstin: string | null;
  invoiceNumber: string | null;
  paidFrom: ExpensePaidFrom;
  reference: string | null;
  note: string | null;
  attachmentUrl: string | null;
  fromDrawer: boolean; // recorded from the POS cash drawer
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
}

/** Expense cost in the P&L: claimable GST is an asset, not a cost. */
export function expenseCost(e: { taxableAmount: number; cgst: number; sgst: number; igst: number; itcEligible: boolean }): number {
  return e.itcEligible ? e.taxableAmount : R(P(e.taxableAmount) + P(e.cgst) + P(e.sgst) + P(e.igst));
}

export interface PnlFigures {
  grossSales: number; // item subtotal before discounts, ex tax
  discounts: number;
  refunds: number; // refunded amounts, net of their tax share
  netSales: number;
  taxCollected: number; // shown for reference — not revenue
  cogs: number; // inventory consumption at cost
  wastage: number;
  grossProfit: number;
  expenses: { category: string; amount: number }[];
  totalExpenses: number;
  payroll: number; // finalised payroll gross + employer contributions (pro-rated by days)
  netProfit: number;
  orders: number;
}

export interface PnlDto {
  outletId: string;
  from: string;
  to: string;
  current: PnlFigures;
  compare: (PnlFigures & { from: string; to: string }) | null;
}

/** Assemble P&L figures in paise from the raw aggregates. */
export function buildPnl(raw: {
  grossSales: number;
  discounts: number;
  refunds: number;
  taxCollected: number;
  cogs: number;
  wastage: number;
  expenses: { category: string; amount: number }[];
  payroll: number;
  orders: number;
}): PnlFigures {
  const netSales = P(raw.grossSales) - P(raw.discounts) - P(raw.refunds);
  const grossProfit = netSales - P(raw.cogs) - P(raw.wastage);
  const byCat = new Map<string, number>();
  for (const e of raw.expenses) byCat.set(e.category, (byCat.get(e.category) ?? 0) + P(e.amount));
  const expenses = [...byCat.entries()].map(([category, p]) => ({ category, amount: R(p) })).sort((a, b) => b.amount - a.amount);
  const totalExpenses = [...byCat.values()].reduce((s, p) => s + p, 0);
  const netProfit = grossProfit - totalExpenses - P(raw.payroll);
  return {
    grossSales: R(P(raw.grossSales)),
    discounts: R(P(raw.discounts)),
    refunds: R(P(raw.refunds)),
    netSales: R(netSales),
    taxCollected: R(P(raw.taxCollected)),
    cogs: R(P(raw.cogs)),
    wastage: R(P(raw.wastage)),
    grossProfit: R(grossProfit),
    expenses,
    totalExpenses: R(totalExpenses),
    payroll: R(P(raw.payroll)),
    netProfit: R(netProfit),
    orders: raw.orders,
  };
}

/** The comparison window for a period: the previous equal-length period, or the same dates a year earlier. */
export function comparePeriod(from: string, to: string, mode: "prev" | "yoy"): { from: string; to: string } {
  if (mode === "yoy") {
    const shift = (d: string) => {
      const [y, m, day] = d.split("-").map(Number);
      const last = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
      return `${y - 1}-${pad2(m)}-${pad2(Math.min(day, last))}`;
    };
    return { from: shift(from), to: shift(to) };
  }
  const len = daysBetween(from, to) + 1;
  return { from: addDays(from, -len), to: addDays(from, -1) };
}

export type DayBookKind =
  | "SALE"
  | "REFUND"
  | "EXPENSE"
  | "CASH_IN"
  | "CASH_OUT"
  | "ADVANCE"
  | "GIFT_CARD_SALE"
  | "PAYROLL";

export interface DayBookEntryDto {
  at: string;
  kind: DayBookKind;
  ref: string | null;
  description: string;
  mode: string; // CASH | CARD | UPI | BANK | GIFT_CARD | …
  inflow: number;
  outflow: number;
}

export interface DayBookDto {
  from: string;
  to: string;
  entries: DayBookEntryDto[];
  byMode: { mode: string; inflow: number; outflow: number; net: number }[];
  totals: { inflow: number; outflow: number; net: number };
}

// ---------- Gift cards / store credit ----------

export const IssueGiftCardSchema = z.object({
  amount: MONEY.refine((n) => n >= 1 && n <= 100000, "Amount must be ₹1 – ₹1,00,000"),
  paymentMode: z.enum(["CASH", "CARD", "UPI", "COMPLIMENTARY"]),
  expiresOn: DATE.nullable().optional(),
  customerName: z.string().max(80).nullable().optional(),
  customerPhone: z.string().max(20).nullable().optional(),
  note: z.string().max(200).optional(),
});
export type IssueGiftCardInput = z.infer<typeof IssueGiftCardSchema>;

export const VoidGiftCardSchema = z.object({ reason: z.string().min(3).max(200) });
export type VoidGiftCardInput = z.infer<typeof VoidGiftCardSchema>;

export type GiftCardKind = "GIFT_CARD" | "STORE_CREDIT";
export type GiftCardStatus = "ACTIVE" | "VOID";

export interface GiftCardDto {
  id: string;
  code: string;
  kind: GiftCardKind;
  initialValue: number;
  balance: number;
  status: GiftCardStatus;
  expired: boolean;
  expiresOn: string | null;
  customerName: string | null;
  customerPhone: string | null;
  issuedOutletId: string;
  createdAt: string;
}

export interface GiftCardTxnDto {
  id: string;
  type: "ISSUE" | "REDEEM" | "VOID" | "STORE_CREDIT";
  amount: number;
  balanceAfter: number;
  orderId: string | null;
  outletId: string;
  paymentMode: string | null;
  note: string | null;
  createdAt: string;
}

export interface GiftCardDetailDto extends GiftCardDto {
  ledger: GiftCardTxnDto[];
}

/** POS balance check — no customer PII. */
export interface GiftCardBalanceDto {
  code: string;
  kind: GiftCardKind;
  balance: number;
  usable: boolean;
  reason: string | null;
  expiresOn: string | null;
}

/** Normalise a typed/scanned gift card code: upper-case, no spaces. */
export function normaliseGiftCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "");
}
