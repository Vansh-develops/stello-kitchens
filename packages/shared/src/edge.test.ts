import { describe, expect, it } from "vitest";
import {
  EdgePushSchema,
  edgeSeriesCode,
  fiscalYearCode,
  formatEdgeBillNumber,
  parseEdgeBillNumber,
} from "./edge";

describe("edge bill numbering", () => {
  it("rolls the fiscal year over on 1 April IST, not UTC", () => {
    expect(fiscalYearCode(new Date("2026-10-26T10:00:00Z"))).toBe("2627");
    expect(fiscalYearCode(new Date("2027-03-31T18:29:59Z"))).toBe("2627"); // 23:59:59 IST 31 Mar
    expect(fiscalYearCode(new Date("2027-03-31T18:30:00Z"))).toBe("2728"); // 00:00 IST 1 Apr
    expect(fiscalYearCode(new Date("2099-06-01T00:00:00Z"))).toBe("9900");
  });

  it("formats GST-safe numbers of at most 16 characters and parses them back", () => {
    const n = formatEdgeBillNumber("E03", "2627", 42);
    expect(n).toBe("E03/2627/000042");
    expect(n.length).toBeLessThanOrEqual(16);
    expect(/^[A-Za-z0-9/-]+$/.test(n)).toBe(true);
    expect(parseEdgeBillNumber(n)).toEqual({ series: "E03", fy: "2627", seq: 42 });
    expect(formatEdgeBillNumber("E100", "2627", 999999).length).toBe(16);
    expect(() => formatEdgeBillNumber("E100", "2627", 1000000)).toThrow(/16 characters/);
    expect(parseEdgeBillNumber("B-12")).toBeNull();
  });

  it("allocates per-outlet series codes", () => {
    expect(edgeSeriesCode(1)).toBe("E01");
    expect(edgeSeriesCode(42)).toBe("E42");
    expect(edgeSeriesCode(100)).toBe("E100");
    expect(() => edgeSeriesCode(0)).toThrow();
  });
});

describe("edge push schema", () => {
  const order = {
    clientId: "c1",
    orderType: "TAKEAWAY",
    items: [{ itemId: "i1", quantity: 1, unitPrice: 100, taxRate: 5 }],
    status: "SETTLED",
    payments: [{ mode: "UPI", amount: 105, reference: "UTR123" }],
    subtotal: 100,
    taxAmount: 5,
    total: 105,
    billNo: { series: "E01", fy: "2627", seq: 1, number: "E01/2627/000001" },
    createdAt: "2026-10-26T10:00:00Z",
    closedAt: "2026-10-26T10:05:00Z",
  };

  it("accepts an order op and defaults optional fields", () => {
    const parsed = EdgePushSchema.parse({ deviceTime: "2026-10-26T10:06:00Z", ops: [{ kind: "ORDER", key: "c1", order }] });
    const op = parsed.ops[0];
    expect(op.kind).toBe("ORDER");
    if (op.kind === "ORDER") {
      expect(op.order.manualDiscount).toBe(0);
      expect(op.order.items[0].prepStatus).toBe("PENDING");
    }
  });

  it("rejects an empty order and malformed series", () => {
    expect(() => EdgePushSchema.parse({ deviceTime: "x", ops: [{ kind: "ORDER", key: "k", order: { ...order, items: [] } }] })).toThrow();
    expect(() =>
      EdgePushSchema.parse({ deviceTime: "x", ops: [{ kind: "ORDER", key: "k", order: { ...order, billNo: { ...order.billNo, series: "B" } } }] }),
    ).toThrow();
  });
});
