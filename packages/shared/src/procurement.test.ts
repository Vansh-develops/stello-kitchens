import { describe, expect, it } from "vitest";
import {
  backtestDaily,
  canReceivePo,
  classifyMenu,
  fitDemandModel,
  forecastAccuracy,
  forecastDaily,
  lineAmountsPaise,
  maxReceivable,
  nextPoStatus,
  poActionsFor,
  priceVariance,
  statusAfterReceipt,
  suggestReorderQty,
  unitFactor,
  type MenuEngineeringInputRow,
} from "./procurement";

describe("unitFactor", () => {
  it("converts compatible units and rejects incompatible ones", () => {
    expect(unitFactor("KG", "G")).toBe(1000);
    expect(unitFactor("G", "KG")).toBe(0.001);
    expect(unitFactor("L", "ML")).toBe(1000);
    expect(unitFactor("PCS", "PCS")).toBe(1);
    expect(unitFactor("KG", "L")).toBeNull();
    expect(unitFactor("PCS", "G")).toBeNull();
  });
});

describe("PO state machine", () => {
  it("walks draft → approved → sent and only allows legal actions", () => {
    expect(nextPoStatus("DRAFT", "approve")).toBe("APPROVED");
    expect(nextPoStatus("APPROVED", "send")).toBe("SENT");
    expect(nextPoStatus("DRAFT", "send")).toBeNull();
    expect(nextPoStatus("SENT", "approve")).toBeNull();
    expect(poActionsFor("DRAFT")).toEqual(["approve", "cancel"]);
    expect(poActionsFor("CANCELLED")).toEqual([]);
    expect(poActionsFor("CLOSED")).toEqual([]);
  });

  it("cannot cancel once goods arrived, only close", () => {
    expect(nextPoStatus("PARTIALLY_RECEIVED", "cancel")).toBeNull();
    expect(nextPoStatus("PARTIALLY_RECEIVED", "close")).toBe("CLOSED");
    expect(nextPoStatus("RECEIVED", "close")).toBe("CLOSED");
    expect(nextPoStatus("SENT", "close")).toBeNull();
  });

  it("receivability and receipt status", () => {
    expect(canReceivePo("DRAFT")).toBe(false);
    expect(canReceivePo("APPROVED")).toBe(true);
    expect(canReceivePo("PARTIALLY_RECEIVED")).toBe(true);
    expect(canReceivePo("RECEIVED")).toBe(false);
    expect(statusAfterReceipt([{ orderedQty: 10, receivedQty: 4 }, { orderedQty: 2, receivedQty: 2 }])).toBe("PARTIALLY_RECEIVED");
    expect(statusAfterReceipt([{ orderedQty: 10, receivedQty: 10.5 }, { orderedQty: 2, receivedQty: 2 }])).toBe("RECEIVED");
  });

  it("over-receipt tolerance", () => {
    expect(maxReceivable(10, 4, 0)).toBe(6);
    expect(maxReceivable(10, 4, 10)).toBe(7);
    expect(maxReceivable(10, 12, 0)).toBe(0);
  });

  it("line money in paise and price variance", () => {
    expect(lineAmountsPaise(2.5, 120.4, 5)).toEqual({ basePaise: 30100, taxPaise: 1505 });
    expect(priceVariance(100, 110, 3)).toEqual({ perUnit: 10, amount: 30, pct: 10 });
    expect(priceVariance(0, 5, 1).pct).toBeNull();
  });
});

describe("demand forecasting", () => {
  // 2026-01-04 is a Sunday → firstDow 0.
  it("forecasts a flat series flat", () => {
    const f = forecastDaily(Array(28).fill(10), 0, 7);
    expect(f).toHaveLength(7);
    for (const v of f) expect(v).toBeCloseTo(10, 6);
  });

  it("returns zeros for no history or no sales", () => {
    expect(forecastDaily([], 0, 3)).toEqual([0, 0, 0]);
    expect(forecastDaily(Array(14).fill(0), 3, 2)).toEqual([0, 0]);
  });

  it("captures day-of-week seasonality", () => {
    // Weekdays sell 10, Fri/Sat sell 30 (Sunday start).
    const history = Array.from({ length: 28 }, (_, i) => ((i % 7 === 5 || i % 7 === 6) ? 30 : 10));
    const model = fitDemandModel(history, 0);
    expect(model.seasonal.reduce((s, v) => s + v, 0) / 7).toBeCloseTo(1, 9);
    const f = forecastDaily(history, 0, 7); // next Sun..Sat
    expect(f[5] / f[1]).toBeGreaterThan(2.3); // Friday vs Monday
    expect(f[6] / f[2]).toBeGreaterThan(2.3);
    expect(Math.abs(f[1] - f[2]) / f[1]).toBeLessThan(0.02);
    // Weekly totals match the history's weekly total within 5%.
    const week = f.reduce((s, v) => s + v, 0);
    expect(Math.abs(week - 110) / 110).toBeLessThan(0.05);
  });

  it("follows an upward trend but damps it", () => {
    const history = Array.from({ length: 28 }, (_, i) => 10 + i);
    const f = forecastDaily(history, 0, 14);
    expect(f[0]).toBeGreaterThan(34);
    expect(f[13]).toBeGreaterThan(f[0]);
    // Damped: grows less than the undamped +1/day.
    expect(f[13] - f[0]).toBeLessThan(13);
  });

  it("is deterministic and backtests one step ahead", () => {
    const history = [5, 7, 6, 8, 12, 15, 9, 6, 7, 6, 9, 13, 14, 8];
    expect(forecastDaily(history, 1, 3)).toEqual(forecastDaily(history, 1, 3));
    const bt = backtestDaily(history, 1, 7);
    expect(bt).toHaveLength(7);
    expect(bt.map((b) => b.actual)).toEqual(history.slice(7));
    expect(bt[0].forecast).toBeCloseTo(forecastDaily(history.slice(0, 7), 1, 1)[0], 9);
  });

  it("scores accuracy with WAPE and bias", () => {
    const s = forecastAccuracy([
      { actual: 10, forecast: 8 },
      { actual: 10, forecast: 12 },
      { actual: 0, forecast: 1 },
    ]);
    expect(s.actual).toBe(20);
    expect(s.forecast).toBe(21);
    expect(s.wape).toBe(0.25);
    expect(s.accuracy).toBe(0.75);
    expect(s.bias).toBe(0.05);
    expect(forecastAccuracy([]).wape).toBeNull();
  });
});

describe("suggestReorderQty", () => {
  it("orders to cover forecast plus safety stock after the lead time", () => {
    const s = suggestReorderQty({ onHand: 5, onOrder: 0, reorderLevel: 2, parLevel: null, usageLead: 3, usageCover: 9 });
    // projected 2, target 11 → 9
    expect(s).toMatchObject({ projectedAtArrival: 2, target: 11, suggested: 9 });
    expect(s.reason).toBe("Forecast demand exceeds projected stock");
  });

  it("counts open POs and par level, rounds up to pack size", () => {
    expect(suggestReorderQty({ onHand: 5, onOrder: 10, reorderLevel: 2, parLevel: null, usageLead: 3, usageCover: 9 }).suggested).toBe(0);
    const par = suggestReorderQty({ onHand: 10, onOrder: 0, reorderLevel: 1, parLevel: 25, usageLead: 0, usageCover: 2, minOrderQty: 4 });
    expect(par.suggested).toBe(16); // 15 → next multiple of 4
    expect(par.reason).toBe("Top up to par level");
    expect(suggestReorderQty({ onHand: 1, onOrder: 0, reorderLevel: 2, parLevel: null, usageLead: 0, usageCover: 0 }).reason).toBe(
      "At or below reorder level",
    );
  });
});

describe("classifyMenu", () => {
  const row = (id: string, qty: number, price: number, foodCost: number): MenuEngineeringInputRow => ({
    itemId: id,
    name: id,
    category: "Mains",
    qty,
    revenue: qty * price,
    listPrice: price,
    foodCost,
    hasRecipe: true,
  });

  it("puts items in the four quadrants", () => {
    const res = classifyMenu([
      row("star", 100, 300, 100), // cm 200, popular
      row("plow", 100, 150, 100), // cm 50, popular
      row("puzzle", 10, 400, 100), // cm 300, unpopular
      row("dog", 10, 120, 100), // cm 20, unpopular
    ]);
    const byId = Object.fromEntries(res.rows.map((r) => [r.itemId, r.class]));
    expect(byId).toEqual({ star: "STAR", plow: "PLOWHORSE", puzzle: "PUZZLE", dog: "DOG" });
    // threshold: 0.7 / 4 = 0.175; avg CM weighted = (200*100+50*100+300*10+20*10)/220
    expect(res.popularityThreshold).toBe(0.175);
    expect(res.avgContributionMargin).toBeCloseTo(28200 / 220, 2);
    expect(res.rows[0].itemId).toBe("star"); // sorted by total margin
  });

  it("uses realised price and flags missing recipes", () => {
    const res = classifyMenu([
      { ...row("a", 10, 100, 0), revenue: 1200, hasRecipe: false },
      row("b", 0, 200, 50),
    ]);
    const a = res.rows.find((r) => r.itemId === "a")!;
    expect(a.avgPrice).toBe(120);
    expect(a.hint).toContain("No recipe");
    const b = res.rows.find((r) => r.itemId === "b")!;
    expect(b.highPopularity).toBe(false);
    expect(b.avgPrice).toBe(200);
  });
});
