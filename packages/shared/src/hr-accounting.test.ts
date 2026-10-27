import { describe, expect, it } from "vitest";
import {
  buildPnl,
  comparePeriod,
  computeDayAttendance,
  computePayslip,
  DEFAULT_PAYROLL_CONFIG,
  expenseCost,
  istAt,
  istDateOf,
  leaveDays,
  summariseMonth,
  type PayInputs,
  type ShiftSpec,
} from "./hr-accounting";

const SHIFT: ShiftSpec = { startTime: "09:00", endTime: "18:00", breakMinutes: 60, graceMinutes: 10 };
const at = (date: string, hhmm: string) => istAt(date, hhmm);

describe("IST helpers", () => {
  it("maps instants to IST business dates regardless of server timezone", () => {
    expect(istDateOf(new Date("2026-10-25T19:00:00Z"))).toBe("2026-10-26"); // 00:30 IST
    expect(istDateOf(new Date("2026-10-25T18:00:00Z"))).toBe("2026-10-25"); // 23:30 IST
    expect(istAt("2026-10-26", "09:00").toISOString()).toBe("2026-10-26T03:30:00.000Z");
  });
  it("counts leave days", () => {
    expect(leaveDays("2026-10-01", "2026-10-03", false)).toBe(3);
    expect(leaveDays("2026-10-01", "2026-10-01", true)).toBe(0.5);
  });
});

describe("computeDayAttendance", () => {
  const d = "2026-10-05";
  it("on time, full shift → present, no late/overtime", () => {
    const r = computeDayAttendance(d, SHIFT, [{ clockIn: at(d, "08:58"), clockOut: at(d, "18:02"), breakMinutes: 60 }]);
    expect(r).toMatchObject({ status: "PRESENT", workedMinutes: 484, scheduledMinutes: 480, lateMinutes: 0, overtimeMinutes: 0 });
  });
  it("within grace is not late; beyond grace counts every minute", () => {
    expect(computeDayAttendance(d, SHIFT, [{ clockIn: at(d, "09:10"), clockOut: at(d, "18:00"), breakMinutes: 60 }]).lateMinutes).toBe(0);
    expect(computeDayAttendance(d, SHIFT, [{ clockIn: at(d, "09:25"), clockOut: at(d, "18:00"), breakMinutes: 60 }]).lateMinutes).toBe(25);
  });
  it("overtime only beyond the threshold", () => {
    const small = computeDayAttendance(d, SHIFT, [{ clockIn: at(d, "09:00"), clockOut: at(d, "18:20"), breakMinutes: 60 }]);
    expect(small.overtimeMinutes).toBe(0);
    const big = computeDayAttendance(d, SHIFT, [{ clockIn: at(d, "09:00"), clockOut: at(d, "20:00"), breakMinutes: 60 }]);
    expect(big.overtimeMinutes).toBe(120);
  });
  it("sums split punches, flags early leave and half days", () => {
    const r = computeDayAttendance(d, SHIFT, [
      { clockIn: at(d, "09:00"), clockOut: at(d, "11:00"), breakMinutes: 0 },
      { clockIn: at(d, "12:00"), clockOut: at(d, "13:30"), breakMinutes: 0 },
    ]);
    expect(r).toMatchObject({ status: "HALF_DAY", workedMinutes: 210, earlyLeaveMinutes: 270 });
  });
  it("handles overnight shifts", () => {
    const night: ShiftSpec = { startTime: "22:00", endTime: "06:00", breakMinutes: 30, graceMinutes: 5 };
    const r = computeDayAttendance(d, night, [{ clockIn: at(d, "22:00"), clockOut: at("2026-10-06", "07:00"), breakMinutes: 30 }]);
    expect(r).toMatchObject({ status: "PRESENT", scheduledMinutes: 450, workedMinutes: 510, overtimeMinutes: 60 });
  });
  it("open punch, absent and off days", () => {
    expect(computeDayAttendance(d, SHIFT, [{ clockIn: at(d, "09:00"), clockOut: null, breakMinutes: 0 }]).status).toBe("OPEN");
    expect(computeDayAttendance(d, SHIFT, []).status).toBe("ABSENT");
    expect(computeDayAttendance(d, null, []).status).toBe("OFF");
  });
});

describe("summariseMonth", () => {
  const full = (date: string) => ({ clockIn: at(date, "09:00"), clockOut: at(date, "18:00"), breakMinutes: 60 });
  it("rostered absences are LOP unless covered by paid leave; offs are free", () => {
    const s = summariseMonth([
      { date: "2026-10-01", shift: SHIFT, punches: [full("2026-10-01")], leave: null, employed: true },
      { date: "2026-10-02", shift: SHIFT, punches: [], leave: null, employed: true }, // absent
      { date: "2026-10-03", shift: SHIFT, punches: [], leave: { type: "SICK", fraction: 1 }, employed: true },
      { date: "2026-10-04", shift: SHIFT, punches: [], leave: { type: "UNPAID", fraction: 1 }, employed: true },
      { date: "2026-10-05", shift: null, punches: [], leave: null, employed: true }, // weekly off
      {
        date: "2026-10-06",
        shift: SHIFT,
        punches: [{ clockIn: at("2026-10-06", "09:00"), clockOut: at("2026-10-06", "12:00"), breakMinutes: 0 }],
        leave: { type: "CASUAL", fraction: 0.5 },
        employed: true,
      },
      { date: "2026-10-07", shift: SHIFT, punches: [], leave: null, employed: false },
    ]);
    expect(s).toMatchObject({ presentDays: 1.5, paidLeaveDays: 1.5, unpaidLeaveDays: 1, absentDays: 1, lopDays: 3 });
  });
});

const base: PayInputs = {
  payType: "MONTHLY",
  payRate: 30000,
  allowances: [],
  deductions: [],
  pfApplicable: false,
  esiApplicable: false,
  ptApplicable: false,
  overtimeEligible: true,
  daysInMonth: 30,
  presentDays: 26,
  paidLeaveDays: 0,
  lopDays: 0,
  workedMinutes: 26 * 480,
  overtimeMinutes: 0,
  advanceDue: 0,
  adjustments: [],
};

describe("computePayslip", () => {
  it("monthly: prorates LOP on calendar days and pays overtime at 2x hourly", () => {
    const r = computePayslip({ ...base, lopDays: 3, overtimeMinutes: 120 });
    // per day 1000, hourly 125, OT 2h × 125 × 2 = 500
    expect(r.basic).toBe(27000);
    expect(r.overtimePay).toBe(500);
    expect(r.gross).toBe(27500);
    expect(r.payableDays).toBe(27);
  });
  it("monthly on a 26-day basis", () => {
    const r = computePayslip({ ...base, payRate: 26000, lopDays: 1 }, { ...DEFAULT_PAYROLL_CONFIG, monthlyBasis: 26 });
    expect(r.basic).toBe(25000);
  });
  it("daily wage pays present days plus paid leave", () => {
    const r = computePayslip({ ...base, payType: "DAILY", payRate: 700, presentDays: 20.5, paidLeaveDays: 1 });
    expect(r.basic).toBe(15050);
  });
  it("hourly pays regular hours; overtime at multiplier", () => {
    const r = computePayslip({ ...base, payType: "HOURLY", payRate: 100, workedMinutes: 6000, overtimeMinutes: 600, paidLeaveDays: 0 });
    expect(r.basic).toBe(9000);
    expect(r.overtimePay).toBe(2000);
  });
  it("applies PF on capped basic, ESI under threshold, PT slab, deductions and advance recovery", () => {
    const r = computePayslip({
      ...base,
      payRate: 18000,
      allowances: [{ name: "HRA", amount: 2000 }],
      deductions: [{ name: "Uniform", amount: 100 }],
      pfApplicable: true,
      esiApplicable: true,
      ptApplicable: true,
      advanceDue: 1500,
    });
    expect(r.gross).toBe(20000);
    expect(r.pfEmployee).toBe(1800); // 12% of 15000 ceiling
    expect(r.pfEmployer).toBe(1800);
    expect(r.esiEmployee).toBe(150); // 0.75% of 20000
    expect(r.esiEmployer).toBe(650);
    expect(r.professionalTax).toBe(0); // under the default 24,999 slab
    expect(r.advanceRecovery).toBe(1500);
    expect(r.totalDeductions).toBe(1800 + 150 + 100 + 1500);
    expect(r.net).toBe(20000 - 3550);
  });
  it("skips ESI above threshold and caps advance recovery at available pay", () => {
    const r = computePayslip({ ...base, payRate: 30000, esiApplicable: true, ptApplicable: true, lopDays: 29, advanceDue: 5000 });
    expect(r.gross).toBe(1000);
    expect(r.esiEmployee).toBe(8); // gross now under threshold: 0.75% of 1000 = 7.5 → 8
    expect(r.advanceRecovery).toBe(992);
    expect(r.net).toBe(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
  it("prorates monthly allowances with attendance and adds adjustments", () => {
    const r = computePayslip({
      ...base,
      allowances: [{ name: "Travel", amount: 3000 }],
      lopDays: 15,
      adjustments: [
        { name: "Bonus", amount: 500, kind: "EARNING" },
        { name: "Damage", amount: 200, kind: "DEDUCTION" },
      ],
    });
    expect(r.basic).toBe(15000);
    expect(r.earnings).toEqual([{ name: "Travel", amount: 1500 }, { name: "Bonus", amount: 500 }]);
    expect(r.net).toBe(15000 + 1500 + 500 - 200);
  });
});

describe("accounting helpers", () => {
  it("expense cost excludes claimable GST", () => {
    expect(expenseCost({ taxableAmount: 1000, cgst: 90, sgst: 90, igst: 0, itcEligible: true })).toBe(1000);
    expect(expenseCost({ taxableAmount: 1000, cgst: 90, sgst: 90, igst: 0, itcEligible: false })).toBe(1180);
  });
  it("builds a P&L in exact paise", () => {
    const p = buildPnl({
      grossSales: 10000.1,
      discounts: 500.05,
      refunds: 100,
      taxCollected: 470,
      cogs: 3000.02,
      wastage: 99.99,
      expenses: [{ category: "Rent", amount: 2000 }, { category: "Power", amount: 300.1 }, { category: "Rent", amount: 0.2 }],
      payroll: 2500,
      orders: 10,
    });
    expect(p.netSales).toBe(9400.05);
    expect(p.grossProfit).toBe(6300.04);
    expect(p.expenses[0]).toEqual({ category: "Rent", amount: 2000.2 });
    expect(p.totalExpenses).toBe(2300.3);
    expect(p.netProfit).toBe(1499.74);
  });
  it("comparison periods", () => {
    expect(comparePeriod("2026-10-01", "2026-10-31", "prev")).toEqual({ from: "2026-08-31", to: "2026-09-30" });
    expect(comparePeriod("2024-02-01", "2024-02-29", "yoy")).toEqual({ from: "2023-02-01", to: "2023-02-28" });
  });
});
