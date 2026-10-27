import { describe, expect, it } from "vitest";
import {
  allocatePaise,
  computeBill,
  isWithinWindow,
  minutesInZone,
  splitLinesEqually,
  SplitOrderSchema,
  BillingSettingsSchema,
} from "./billing";
import { computeOrderTotals, toPaise } from "./money";

const line = (rupees: number, rate = 5) => ({ lineTotalPaise: toPaise(rupees), taxRatePercent: rate });

describe("computeBill", () => {
  it("matches computeOrderTotals exactly with no service charge or round-off", () => {
    const cases = [
      [[line(100)], 0],
      [[line(33.33, 5), line(66.67, 18), line(10.1, 12)], 7.77],
      [[line(0.01, 5), line(999.99, 28)], 1000],
      [[], 5],
    ] as const;
    for (const [lines, discount] of cases) {
      const plain = computeOrderTotals([...lines], discount);
      const bill = computeBill([...lines], { discountRupees: discount });
      expect(bill).toMatchObject(plain);
      expect(bill.serviceChargeAmount).toBe(0);
      expect(bill.roundOff).toBe(0);
    }
  });

  it("charges service charge on the post-discount value and taxes it when taxable", () => {
    const lines = [line(1000, 5)];
    const taxable = computeBill(lines, { discountRupees: 100, serviceCharge: { percent: 10, taxable: true } });
    expect(taxable.serviceChargeAmount).toBe(90); // 10% of 900
    expect(taxable.taxAmount).toBe(49.5); // 5% of (900 + 90)
    expect(taxable.total).toBe(1039.5);
    const exempt = computeBill(lines, { discountRupees: 100, serviceCharge: { percent: 10, taxable: false } });
    expect(exempt.serviceChargeAmount).toBe(90);
    expect(exempt.taxAmount).toBe(45);
    expect(exempt.total).toBe(1035);
  });

  it("taxes a taxable service charge at the blended line rate", () => {
    const bill = computeBill([line(100, 5), line(100, 18)], { discountRupees: 0, serviceCharge: { percent: 10, taxable: true } });
    // raw tax 23 on 200 → blended 11.5%; base 200 + 20 = 220 → 25.30
    expect(bill.serviceChargeAmount).toBe(20);
    expect(bill.taxAmount).toBe(25.3);
    expect(bill.total).toBe(245.3);
  });

  it("rounds to the nearest rupee and records the signed round-off", () => {
    const down = computeBill([line(100, 5), line(4.4, 0)], { discountRupees: 0, roundOff: true }); // 109.40
    expect(down.totalBeforeRoundOff).toBe(109.4);
    expect(down.total).toBe(109);
    expect(down.roundOff).toBe(-0.4);
    const up = computeBill([line(100, 5), line(4.5, 0)], { discountRupees: 0, roundOff: true }); // 109.50
    expect(up.total).toBe(110);
    expect(up.roundOff).toBe(0.5);
    const exact = computeBill([line(100, 5)], { discountRupees: 0, roundOff: true });
    expect(exact.roundOff).toBe(0);
  });

  it("keeps every component in whole paise and the total internally consistent", () => {
    for (let seed = 1; seed < 400; seed++) {
      const n = (seed % 7) + 1;
      const lines = Array.from({ length: n }, (_, i) => line(((seed * 37 + i * 101) % 99999) / 100, [0, 5, 12, 18, 28][(seed + i) % 5]));
      const bill = computeBill(lines, {
        discountRupees: (seed % 13) * 1.37,
        serviceCharge: seed % 3 ? { percent: [5, 7.5, 10][seed % 3], taxable: seed % 2 === 0 } : null,
        roundOff: seed % 4 === 0,
      });
      const p = (x: number) => toPaise(x);
      for (const v of Object.values(bill)) expect(Number.isInteger(p(v))).toBe(true);
      expect(p(bill.total)).toBe(p(bill.subtotal) - p(bill.discountAmount) + p(bill.serviceChargeAmount) + p(bill.taxAmount) + p(bill.roundOff));
      if (bill.roundOff !== 0 || seed % 4 === 0) expect(p(bill.total) % 100).toBe(0);
      expect(Math.abs(p(bill.roundOff))).toBeLessThanOrEqual(50);
    }
  });
});

describe("allocatePaise", () => {
  it("allocates proportionally and sums exactly", () => {
    expect(allocatePaise(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocatePaise(1000, [300, 700])).toEqual([300, 700]);
    expect(allocatePaise(7, [0, 0])).toEqual([4, 3]);
    for (let t = 0; t < 500; t += 7) {
      const w = [t % 5, 3, (t * 13) % 11, 1];
      expect(allocatePaise(t, w).reduce((s, x) => s + x, 0)).toBe(t);
    }
  });
});

describe("splitLinesEqually", () => {
  it("preserves each line exactly and balances checks within a paisa", () => {
    const lines = [10001, 3, 25099, 1, 1, 777];
    for (const parts of [2, 3, 4, 7]) {
      const out = splitLinesEqually(lines, parts);
      lines.forEach((p, i) => expect(out.reduce((s, c) => s + c[i], 0)).toBe(p));
      const totals = out.map((c) => c.reduce((s, x) => s + x, 0));
      expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(1);
    }
  });
});

describe("availability windows", () => {
  it("handles open, same-day and overnight windows", () => {
    expect(isWithinWindow(null, null, 0)).toBe(true);
    expect(isWithinWindow("07:00", "11:00", 7 * 60)).toBe(true);
    expect(isWithinWindow("07:00", "11:00", 11 * 60)).toBe(false); // end-exclusive
    expect(isWithinWindow("07:00", "11:00", 6 * 60 + 59)).toBe(false);
    expect(isWithinWindow("22:00", "02:00", 23 * 60)).toBe(true);
    expect(isWithinWindow("22:00", "02:00", 60)).toBe(true);
    expect(isWithinWindow("22:00", "02:00", 12 * 60)).toBe(false);
    expect(isWithinWindow("18:00", null, 19 * 60)).toBe(true);
    expect(isWithinWindow(null, "11:00", 12 * 60)).toBe(false);
  });

  it("resolves local minutes in the outlet's time zone", () => {
    const utcMidnight = new Date("2026-10-26T00:00:00Z");
    expect(minutesInZone(utcMidnight, "Asia/Kolkata")).toBe(5 * 60 + 30);
    expect(minutesInZone(utcMidnight, "UTC")).toBe(0);
    expect(minutesInZone(utcMidnight, "Not/AZone")).toBe(5 * 60 + 30); // falls back to IST
  });
});

describe("schemas", () => {
  it("validates split and settings input", () => {
    expect(SplitOrderSchema.safeParse({ mode: "EQUAL", parts: 1 }).success).toBe(false);
    expect(SplitOrderSchema.safeParse({ mode: "EQUAL", parts: 3 }).success).toBe(true);
    expect(SplitOrderSchema.safeParse({ mode: "ITEMS", checks: [{ lines: [{ orderItemId: "a", quantity: 1 }] }] }).success).toBe(false);
    const ok = { serviceChargeEnabled: true, serviceChargePercent: 10, serviceChargeTaxable: true, serviceChargeOrderTypes: ["DINE_IN"], roundOffEnabled: true, timezone: "Asia/Kolkata" };
    expect(BillingSettingsSchema.safeParse(ok).success).toBe(true);
    expect(BillingSettingsSchema.safeParse({ ...ok, timezone: "Mars/Base" }).success).toBe(false);
    expect(BillingSettingsSchema.safeParse({ ...ok, serviceChargePercent: 45 }).success).toBe(false);
  });
});
