import { describe, expect, it } from "vitest";
import { CfdStateSchema, ReservationInputSchema, type TablePlacementInput, SaveFloorPlanSchema, floorLayoutIssues, intervalsOverlap } from "./foh";

const table = (over: Partial<TablePlacementInput> = {}) => ({
  name: "T1",
  seats: 4,
  shape: "SQUARE" as const,
  x: 10,
  y: 10,
  width: 80,
  height: 80,
  rotation: 0,
  ...over,
});

describe("floor layout validation", () => {
  it("accepts a well-formed plan", () => {
    const res = SaveFloorPlanSchema.safeParse({ width: 800, height: 600, tables: [table(), table({ name: "T2", x: 120 })] });
    expect(res.success).toBe(true);
  });

  it("rejects tables outside the canvas", () => {
    expect(floorLayoutIssues({ width: 500, height: 500, tables: [table({ x: 450 })] })[0].message).toContain("outside");
    expect(floorLayoutIssues({ width: 500, height: 500, tables: [table({ y: -1 })] })).toHaveLength(1);
  });

  it("rejects overlapping tables but allows touching edges", () => {
    expect(floorLayoutIssues({ width: 800, height: 600, tables: [table(), table({ name: "T2", x: 50 })] })[0].message).toContain("overlaps");
    expect(floorLayoutIssues({ width: 800, height: 600, tables: [table(), table({ name: "T2", x: 90 })] })).toEqual([]);
  });

  it("requires round tables to be circles", () => {
    expect(floorLayoutIssues({ width: 800, height: 600, tables: [table({ shape: "ROUND", width: 80, height: 60 })] })).toHaveLength(1);
  });

  it("rejects duplicate names and duplicate table ids", () => {
    const issues = floorLayoutIssues({
      width: 800,
      height: 600,
      tables: [table({ tableId: "a" }), table({ tableId: "a", name: "t1", x: 200 })],
    });
    expect(issues.map((i) => i.message)).toEqual(expect.arrayContaining(["Duplicate table name t1", "t1 is placed twice"]));
  });

  it("bounds sizes, seats and rotation through the schema", () => {
    expect(SaveFloorPlanSchema.safeParse({ width: 800, height: 600, tables: [table({ width: 10 })] }).success).toBe(false);
    expect(SaveFloorPlanSchema.safeParse({ width: 800, height: 600, tables: [{ ...table(), seats: 0 }] }).success).toBe(false);
    expect(SaveFloorPlanSchema.safeParse({ width: 800, height: 600, tables: [table({ rotation: 360 })] }).success).toBe(false);
    expect(SaveFloorPlanSchema.safeParse({ width: 50, height: 600, tables: [] }).success).toBe(false);
  });
});

describe("reservation helpers", () => {
  const t = Date.parse("2026-10-26T19:00:00Z");
  it("treats intervals as half-open", () => {
    expect(intervalsOverlap(t, 90, t + 90 * 60_000, 60)).toBe(false);
    expect(intervalsOverlap(t, 90, t + 89 * 60_000, 60)).toBe(true);
    expect(intervalsOverlap(t + 30 * 60_000, 30, t, 120)).toBe(true);
  });

  it("validates reservation input", () => {
    const ok = ReservationInputSchema.safeParse({ guestName: "Asha", phone: "9876543210", partySize: 4, startAt: "2026-10-26T19:00:00+05:30" });
    expect(ok.success && ok.data.durationMinutes).toBe(90);
    expect(ReservationInputSchema.safeParse({ guestName: "Asha", phone: "abc", partySize: 4, startAt: "2026-10-26T19:00:00Z" }).success).toBe(false);
    expect(ReservationInputSchema.safeParse({ guestName: "Asha", phone: "9876543210", partySize: 0, startAt: "2026-10-26T19:00:00Z" }).success).toBe(false);
  });
});

describe("customer display state", () => {
  it("only accepts upi:// payment strings", () => {
    const base = { mode: "PAYMENT", lines: [], total: 105 };
    expect(CfdStateSchema.safeParse({ ...base, upi: { upiString: "upi://pay?pa=x@y", amount: 105, payeeVpa: "x@y" } }).success).toBe(true);
    expect(CfdStateSchema.safeParse({ ...base, upi: { upiString: "https://evil.example", amount: 105, payeeVpa: "x@y" } }).success).toBe(false);
  });
});
