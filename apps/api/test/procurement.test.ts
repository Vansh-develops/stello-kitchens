import { afterAll, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "@stello/shared";
import { PrismaService } from "../src/prisma/prisma.service";
import { OrdersService } from "../src/orders/orders.service";
import { InventoryService } from "../src/inventory/inventory.service";
import { PurchaseOrdersService } from "../src/procurement/purchase-orders.service";
import { PayablesService } from "../src/procurement/payables.service";
import { StocktakeService } from "../src/procurement/stocktake.service";
import { PlanningService } from "../src/procurement/planning.service";
import { InsightsService } from "../src/procurement/insights.service";
import { testPrisma } from "./db";

const prisma = new PrismaService();
afterAll(() => prisma.$disconnect());
const realtime = { notifyOutlet: vi.fn() };
const inventory = new InventoryService(prisma, realtime as any);
const orders = new OrdersService(prisma, realtime as any, { verifyAndConsume: vi.fn() } as any);
const pos = new PurchaseOrdersService(prisma, realtime as any, inventory);
const payables = new PayablesService(prisma);
const stocktake = new StocktakeService(prisma, realtime as any);
const planning = new PlanningService(prisma, pos);
const insights = new InsightsService(prisma);

async function fixture() {
  const tenant = await prisma.tenant.create({ data: { name: "Proc" } });
  const role = await prisma.role.create({ data: { tenantId: tenant.id, name: "Owner", permissions: ["*"] } });
  const actor = await prisma.user.create({
    data: { tenantId: tenant.id, roleId: role.id, name: "Owner", email: `${tenant.id}@example.com`, passwordHash: "x" },
  });
  const brand = await prisma.brand.create({ data: { tenantId: tenant.id, name: "Brand" } });
  const outlet = await prisma.outlet.create({ data: { tenantId: tenant.id, brandId: brand.id, name: "Outlet" } });
  const category = await prisma.menuCategory.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Mains" } });
  const vendor = await prisma.vendor.create({
    data: { tenantId: tenant.id, outletId: outlet.id, name: "Fresh Farms", paymentTermsDays: 15 },
  });
  const chicken = await prisma.rawMaterial.create({
    data: { tenantId: tenant.id, outletId: outlet.id, name: "Chicken", unit: "KG", stockQty: 10, costPerUnit: 100, reorderLevel: 2 },
  });
  const item = await prisma.item.create({
    data: { tenantId: tenant.id, outletId: outlet.id, categoryId: category.id, name: "Chicken Curry", price: 200, taxRate: 5 },
  });
  await prisma.recipeIngredient.create({ data: { itemId: item.id, rawMaterialId: chicken.id, quantity: 0.5 } });
  const user: AuthUser = {
    id: actor.id, tenantId: tenant.id, email: actor.email, name: "Owner", roleName: "Owner",
    permissions: ["*"], outletIds: [outlet.id], isPlatformAdmin: false,
  };
  return { tenant, outlet, category, vendor, chicken, item, user };
}

const stock = async (id: string) => {
  const m = await prisma.rawMaterial.findUniqueOrThrow({ where: { id } });
  return { qty: Number(m.stockQty), cost: Number(m.costPerUnit) };
};

async function approvedPo(f: Awaited<ReturnType<typeof fixture>>, qty = 20, rate = 120) {
  const po = await pos.create(f.user, f.outlet.id, {
    vendorId: f.vendor.id,
    lines: [{ rawMaterialId: f.chicken.id, quantity: qty, rate, taxRate: 5 }],
  });
  await pos.act(f.user, f.outlet.id, po.id, { action: "approve" });
  const full = await pos.get(f.user, f.outlet.id, po.id);
  return { ...po, lineId: full.lines[0].id };
}

describe("purchase-order state machine", () => {
  it("numbers POs, gates approval by permission and enforces transitions", async () => {
    const f = await fixture();
    const a = await pos.create(f.user, f.outlet.id, {
      vendorId: f.vendor.id,
      lines: [{ rawMaterialId: f.chicken.id, quantity: 2.5, rate: 120.4, taxRate: 5 }],
    });
    const b = await pos.create(f.user, f.outlet.id, {
      vendorId: f.vendor.id,
      lines: [{ rawMaterialId: f.chicken.id, quantity: 1, rate: 100 }],
    });
    expect([a.poNumber, b.poNumber]).toEqual(["PO-00001", "PO-00002"]);
    const draft = await pos.get(f.user, f.outlet.id, a.id);
    expect(draft).toMatchObject({ status: "DRAFT", subtotal: 301, taxAmount: 15.05, total: 316.05, allowedActions: ["approve", "cancel"] });

    const clerk = { ...f.user, permissions: ["purchase.manage"] };
    await expect(pos.act(clerk, f.outlet.id, a.id, { action: "approve" })).rejects.toThrow("purchase.approve");
    await expect(pos.act(f.user, f.outlet.id, a.id, { action: "send" })).rejects.toThrow("Can't send");
    await expect(pos.receive(f.user, f.outlet.id, a.id, { lines: [{ poLineId: draft.lines[0].id, quantity: 1 }], createBill: false }))
      .rejects.toThrow("Can't receive");

    expect(await pos.act(f.user, f.outlet.id, a.id, { action: "approve" })).toEqual({ id: a.id, status: "APPROVED" });
    await expect(pos.update(f.user, f.outlet.id, a.id, { note: "late edit" })).rejects.toThrow("can't be edited");
    expect((await pos.act(f.user, f.outlet.id, a.id, { action: "send" })).status).toBe("SENT");
    expect((await pos.act(f.user, f.outlet.id, a.id, { action: "cancel", reason: "vendor out" })).status).toBe("CANCELLED");
    await expect(pos.act(f.user, f.outlet.id, a.id, { action: "close" })).rejects.toThrow();
    expect(await prisma.auditLog.count({ where: { entityId: a.id } })).toBe(3);
  });

  it("rejects incompatible purchase units and foreign vendors", async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(pos.create(f.user, f.outlet.id, {
      vendorId: f.vendor.id, lines: [{ rawMaterialId: f.chicken.id, quantity: 1, unit: "L", rate: 1, taxRate: 0 }],
    })).rejects.toThrow("can't be bought in L");
    await expect(pos.create(f.user, f.outlet.id, {
      vendorId: other.vendor.id, lines: [{ rawMaterialId: f.chicken.id, quantity: 1, rate: 1, taxRate: 0 }],
    })).rejects.toThrow("Vendor not found");
    await expect(pos.create(f.user, f.outlet.id, {
      vendorId: f.vendor.id, lines: [{ rawMaterialId: other.chicken.id, quantity: 1, rate: 1, taxRate: 0 }],
    })).rejects.toThrow("Unknown material");
  });
});

describe("goods receipt against a PO", () => {
  it("handles partial receipts, weighted-average cost, price variance and over-receipt", async () => {
    const f = await fixture();
    const po = await approvedPo(f);

    const g1 = await pos.receive(f.user, f.outlet.id, po.id, { lines: [{ poLineId: po.lineId, quantity: 5 }], createBill: false });
    expect(g1).toMatchObject({ grnNumber: "GRN-00001", status: "PARTIALLY_RECEIVED", total: 630, varianceAmount: 0 });
    let s = await stock(f.chicken.id);
    expect(s.qty).toBe(15);
    expect(s.cost).toBeCloseTo((10 * 100 + 5 * 120) / 15, 3);

    const g2 = await pos.receive(f.user, f.outlet.id, po.id, {
      invoiceNo: "INV-77", lines: [{ poLineId: po.lineId, quantity: 15, rate: 130 }], createBill: true,
    });
    expect(g2).toMatchObject({ status: "RECEIVED", varianceAmount: 150 });
    expect(g2.billId).toBeTruthy();
    s = await stock(f.chicken.id);
    expect(s.qty).toBe(30);
    expect(s.cost).toBeCloseTo((15 * ((10 * 100 + 5 * 120) / 15) + 15 * 130) / 30, 3);

    // Fully received: no further receipts, no over-receipt.
    await expect(pos.receive(f.user, f.outlet.id, po.id, { lines: [{ poLineId: po.lineId, quantity: 1 }], createBill: false }))
      .rejects.toThrow("Can't receive");
    const movements = await prisma.stockMovement.findMany({ where: { rawMaterialId: f.chicken.id, refType: "grn" } });
    expect(movements.map((m) => Number(m.quantity)).sort()).toEqual([15, 5]);
    expect(movements.every((m) => m.vendorId === f.vendor.id)).toBe(true);

    const history = await pos.priceHistory(f.user, f.outlet.id, { vendorId: f.vendor.id });
    expect(history.map((h) => h.unitCost)).toEqual([130, 120]);
    expect(history[0].poUnitCost).toBe(120);

    const bill = (await payables.listBills(f.user, f.outlet.id, {}))[0];
    expect(bill).toMatchObject({ billNumber: "INV-77", amount: 2047.5, status: "OPEN", grnNumber: "GRN-00002" });
    expect((await pos.act(f.user, f.outlet.id, po.id, { action: "close" })).status).toBe("CLOSED");
  });

  it("applies the over-receipt tolerance and converts purchase units", async () => {
    const f = await fixture();
    const po = await approvedPo(f, 10, 120);
    await expect(pos.receive(f.user, f.outlet.id, po.id, { lines: [{ poLineId: po.lineId, quantity: 10.5 }], createBill: false }))
      .rejects.toThrow("Over-receipt");
    await pos.saveSettings(f.user, f.outlet.id, { overReceiptPct: 10, priceVarianceAlertPct: 5, coverDays: 3, leadDays: 1, lookbackDays: 28 });
    const r = await pos.receive(f.user, f.outlet.id, po.id, { lines: [{ poLineId: po.lineId, quantity: 10.5 }], createBill: false });
    expect(r.status).toBe("RECEIVED");
    expect((await stock(f.chicken.id)).qty).toBe(20.5);

    // Bought in grams for a KG material: 2000 G @ ₹0.15/G → +2 KG at ₹150/KG.
    const g = await pos.create(f.user, f.outlet.id, {
      vendorId: f.vendor.id, lines: [{ rawMaterialId: f.chicken.id, quantity: 2000, unit: "G", rate: 0.15, taxRate: 0 }],
    });
    await pos.act(f.user, f.outlet.id, g.id, { action: "approve" });
    const line = (await pos.get(f.user, f.outlet.id, g.id)).lines[0];
    expect(line).toMatchObject({ unit: "G", unitFactor: 0.001, materialUnit: "KG" });
    await pos.receive(f.user, f.outlet.id, g.id, { lines: [{ poLineId: line.id, quantity: 2000 }], createBill: false });
    const s = await stock(f.chicken.id);
    expect(s.qty).toBe(22.5);
    expect(s.cost).toBeCloseTo((20.5 * ((10 * 100 + 10.5 * 120) / 20.5) + 2 * 150) / 22.5, 3);
  });

  it("serialises competing receipts so a line is never over-received", async () => {
    const f = await fixture();
    const po = await approvedPo(f, 20, 120);
    const results = await Promise.allSettled(
      [0, 1, 2].map(() => pos.receive(f.user, f.outlet.id, po.id, { lines: [{ poLineId: po.lineId, quantity: 8 }], createBill: false })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const line = await prisma.purchaseOrderLine.findUniqueOrThrow({ where: { id: po.lineId } });
    expect(Number(line.receivedQty)).toBe(16);
    expect((await stock(f.chicken.id)).qty).toBe(26);
    expect(await prisma.goodsReceipt.count()).toBe(2);
  });
});

describe("vendor payables", () => {
  it("allocates payments oldest-first, keeps credit and reports outstanding", async () => {
    const f = await fixture();
    await payables.createBill(f.user, f.outlet.id, { vendorId: f.vendor.id, billNumber: "B1", billDate: "2026-01-01", amount: 1000 });
    await payables.createBill(f.user, f.outlet.id, { vendorId: f.vendor.id, billNumber: "B2", billDate: "2026-02-01", amount: 500 });
    await expect(payables.createBill(f.user, f.outlet.id, { vendorId: f.vendor.id, billNumber: "B2", billDate: "2026-02-01", amount: 5 }))
      .rejects.toThrow("already booked");

    const p1 = await payables.recordPayment(f.user, f.outlet.id, { vendorId: f.vendor.id, amount: 1200, mode: "BANK" });
    expect(p1).toMatchObject({ allocated: 1200, unallocated: 0 });
    const bills = await payables.listBills(f.user, f.outlet.id, {});
    const byNo = Object.fromEntries(bills.map((b) => [b.billNumber, b]));
    expect(byNo.B1).toMatchObject({ status: "PAID", outstanding: 0 });
    expect(byNo.B2).toMatchObject({ status: "PARTIAL", outstanding: 300, overdue: true });

    const p2 = await payables.recordPayment(f.user, f.outlet.id, { vendorId: f.vendor.id, amount: 400, mode: "UPI" });
    expect(p2).toMatchObject({ allocated: 300, unallocated: 100 });
    const [row] = await payables.payables(f.user, f.outlet.id);
    expect(row).toMatchObject({ billed: 1500, paid: 1600, outstanding: 0, credit: 100, openBills: 0 });

    await payables.createBill(f.user, f.outlet.id, { vendorId: f.vendor.id, billNumber: "B3", billDate: "2026-03-01", amount: 50 });
    const b3 = (await payables.listBills(f.user, f.outlet.id, { status: "UNPAID" }))[0];
    await expect(payables.recordPayment(f.user, f.outlet.id, {
      vendorId: f.vendor.id, amount: 10, mode: "CASH", allocations: [{ billId: b3.id, amount: 60 }],
    })).rejects.toThrow("exceeds");
    expect((await payables.voidBill(f.user, f.outlet.id, b3.id)).status).toBe("VOID");
  });
});

describe("stocktake", () => {
  it("freezes expected qty, posts variance as an ADJUSTMENT delta and preserves concurrent sales", async () => {
    const f = await fixture();
    const sc = await stocktake.create(f.user, f.outlet.id, { scope: "FULL" });
    expect(sc.countNumber).toBe("SC-00001");
    await expect(stocktake.create(f.user, f.outlet.id, { scope: "FULL" })).rejects.toThrow("still open");

    // A sale during the count depletes 2 KG (4 × 0.5).
    await orders.create(f.user, { outletId: f.outlet.id, orderType: "TAKEAWAY", items: [{ itemId: f.item.id, quantity: 4, addonIds: [] }], combos: [] });
    expect((await stock(f.chicken.id)).qty).toBe(8);

    let view = await stocktake.get(f.user, f.outlet.id, sc.id);
    expect(view.lines[0]).toMatchObject({ expectedQty: 10, movedSinceFreeze: -2, countedQty: null });
    await stocktake.enterCounts(f.user, f.outlet.id, sc.id, { entries: [{ lineId: view.lines[0].id, countedQty: 9, note: "spoilage" }] });
    view = await stocktake.get(f.user, f.outlet.id, sc.id);
    expect(view.lines[0]).toMatchObject({ varianceQty: -1, varianceValue: -100 });
    expect(view.shrinkageValue).toBe(-100);

    await stocktake.submit(f.user, f.outlet.id, sc.id);
    const posted = await stocktake.post(f.user, f.outlet.id, sc.id);
    expect(posted).toMatchObject({ status: "POSTED", adjusted: 1, varianceValue: -100 });
    // Counted 9 at freeze, minus 2 sold since → 7.
    expect((await stock(f.chicken.id)).qty).toBe(7);
    const adj = await prisma.stockMovement.findFirstOrThrow({ where: { type: "ADJUSTMENT", refId: sc.id } });
    expect(Number(adj.quantity)).toBe(-1);
    expect(Number(adj.unitCost)).toBe(100);
    await expect(stocktake.post(f.user, f.outlet.id, sc.id)).rejects.toThrow("posted");
    await expect(stocktake.enterCounts(f.user, f.outlet.id, sc.id, { entries: [{ lineId: view.lines[0].id, countedQty: 1 }] }))
      .rejects.toThrow("posted");
    expect((await stocktake.list(f.user, f.outlet.id))[0]).toMatchObject({ status: "POSTED", countedCount: 1, varianceValue: -100 });
  });

  it("posts exactly once under contention and interleaves safely with sales deduction", async () => {
    const f = await fixture();
    const sc = await stocktake.create(f.user, f.outlet.id, { scope: "FULL" });
    const line = (await stocktake.get(f.user, f.outlet.id, sc.id)).lines[0];
    await stocktake.enterCounts(f.user, f.outlet.id, sc.id, { entries: [{ lineId: line.id, countedQty: 12 }] });

    // Hold the material row so the posts and a sale all queue behind it.
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>((r) => (ready = r));
    const gate = new Promise<void>((r) => (release = r));
    const blocker = testPrisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM raw_materials WHERE id = ${f.chicken.id} FOR UPDATE`;
      ready();
      await gate;
    });
    await held;
    const jobs = Promise.allSettled([
      stocktake.post(f.user, f.outlet.id, sc.id),
      stocktake.post(f.user, f.outlet.id, sc.id),
      orders.create(f.user, { outletId: f.outlet.id, orderType: "TAKEAWAY", items: [{ itemId: f.item.id, quantity: 2, addonIds: [] }], combos: [] }),
    ]);
    await new Promise((r) => setTimeout(r, 200));
    release();
    await blocker;
    const results = await jobs;
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(await prisma.stockMovement.count({ where: { type: "ADJUSTMENT", refId: sc.id } })).toBe(1);
    // 10 + 2 (count surplus) − 1 (sale) regardless of interleaving.
    expect((await stock(f.chicken.id)).qty).toBe(11);
  });

  it("scopes a count to a category", async () => {
    const f = await fixture();
    const onion = await prisma.rawMaterial.create({
      data: { tenantId: f.tenant.id, outletId: f.outlet.id, name: "Onion", unit: "KG", stockQty: 5, costPerUnit: 30 },
    });
    await planning.savePlanning(f.user, f.outlet.id, { rows: [{ rawMaterialId: onion.id, category: "Veg" }, { rawMaterialId: f.chicken.id, category: "Meat" }] });
    expect(await stocktake.categories(f.user, f.outlet.id)).toEqual(["Meat", "Veg"]);
    const sc = await stocktake.create(f.user, f.outlet.id, { scope: "CATEGORY", category: "Veg" });
    const view = await stocktake.get(f.user, f.outlet.id, sc.id);
    expect(view.lines.map((l) => l.materialName)).toEqual(["Onion"]);
    // A different category may run alongside; a full count may not.
    await stocktake.create(f.user, f.outlet.id, { scope: "CATEGORY", category: "Meat" });
    await expect(stocktake.create(f.user, f.outlet.id, { scope: "FULL" })).rejects.toThrow("still open");
  });
});

describe("forecasting and purchase suggestions", () => {
  async function seedSales(f: Awaited<ReturnType<typeof fixture>>, perDay: (dow: number) => number, days: number) {
    const today = new Date();
    for (let back = days; back >= 1; back--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back, 12);
      const qty = perDay(d.getDay());
      if (!qty) continue;
      await prisma.order.create({
        data: {
          tenantId: f.tenant.id, outletId: f.outlet.id, orderType: "TAKEAWAY", status: "SETTLED", createdAt: d,
          items: { create: [{ itemId: f.item.id, itemName: f.item.name, quantity: qty, unitPrice: 200, lineTotal: 200 * qty }] },
        },
      });
    }
  }

  it("forecasts item and material demand from recent sales", async () => {
    const f = await fixture();
    await seedSales(f, () => 4, 42);
    const fc = await planning.forecast(f.user, f.outlet.id, 7);
    expect(fc.days).toHaveLength(7);
    expect(fc.items[0].itemId).toBe(f.item.id);
    for (const v of fc.items[0].forecast) expect(v).toBeCloseTo(4, 1);
    expect(fc.materials[0]).toMatchObject({ rawMaterialId: f.chicken.id, onHand: 10 });
    expect(fc.materials[0].total).toBeCloseTo(14, 1); // 7 days × 4 × 0.5 KG
    expect(fc.materials[0].daysOfCover).toBeCloseTo(5, 1);

    const acc = await planning.accuracy(f.user, f.outlet.id, 14);
    expect(acc.days).toHaveLength(14);
    expect(acc.summary.actual).toBe(56);
    expect(acc.summary.accuracy).toBeGreaterThan(0.95);
    expect(acc.items[0].accuracy).toBeGreaterThan(0.95);
  });

  it("suggests a PO per vendor from forecast, reorder level and open POs", async () => {
    const f = await fixture();
    await seedSales(f, () => 4, 28);
    await prisma.rawMaterial.update({ where: { id: f.chicken.id }, data: { stockQty: 1 } });
    await planning.savePlanning(f.user, f.outlet.id, { rows: [{ rawMaterialId: f.chicken.id, preferredVendorId: f.vendor.id }] });
    // cover 3 days, lead 1 day, usage 2 KG/day: projected 1 − 2 = −1; target 6 + 2 → order 9.
    let sug = await planning.suggestions(f.user, f.outlet.id);
    expect(sug.groups).toHaveLength(1);
    expect(sug.groups[0].vendorId).toBe(f.vendor.id);
    const line = sug.groups[0].lines[0];
    expect(line.usageLead).toBeCloseTo(2, 1);
    expect(line.usageCover).toBeCloseTo(6, 1);
    expect(line.suggestedQty).toBeCloseTo(9, 1);
    expect(line.rate).toBe(100);

    const created = await planning.createPurchaseOrders(f.user, f.outlet.id, {
      lines: [{ rawMaterialId: f.chicken.id, vendorId: f.vendor.id, quantity: 9, rate: 100 }],
    });
    expect(created).toHaveLength(1);
    // A draft doesn't count as on order; an approved one does.
    expect((await planning.suggestions(f.user, f.outlet.id)).groups).toHaveLength(1);
    await pos.act(f.user, f.outlet.id, created[0].id, { action: "approve" });
    sug = await planning.suggestions(f.user, f.outlet.id);
    expect(sug.groups).toHaveLength(0);
  });
});

describe("menu engineering", () => {
  it("classifies items by popularity and recipe-cost contribution margin", async () => {
    const f = await fixture();
    const mk = async (name: string, price: number, cost: number) => {
      const m = await prisma.rawMaterial.create({
        data: { tenantId: f.tenant.id, outletId: f.outlet.id, name: `${name} base`, unit: "PCS", costPerUnit: cost },
      });
      const it = await prisma.item.create({ data: { tenantId: f.tenant.id, outletId: f.outlet.id, categoryId: f.category.id, name, price } });
      await prisma.recipeIngredient.create({ data: { itemId: it.id, rawMaterialId: m.id, quantity: 1 } });
      return it;
    };
    const star = await mk("Star", 300, 100);
    const plow = await mk("Plow", 150, 100);
    const puzzle = await mk("Puzzle", 400, 100);
    const dog = await mk("Dog", 120, 100);
    const sell = (it: { id: string; name: string }, qty: number, price: number) =>
      prisma.order.create({
        data: {
          tenantId: f.tenant.id, outletId: f.outlet.id, orderType: "TAKEAWAY", status: "SETTLED",
          items: { create: [{ itemId: it.id, itemName: it.name, quantity: qty, unitPrice: price, lineTotal: qty * price }] },
        },
      });
    await sell(star, 100, 300);
    await sell(plow, 100, 150);
    await sell(puzzle, 10, 400);
    await sell(dog, 10, 120);
    const today = new Date();
    const d = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const res = await insights.menuEngineering(f.user, f.outlet.id, d, d, f.category.id);
    const cls = Object.fromEntries(res.rows.map((r) => [r.name, r.class]));
    // The fixture's Chicken Curry sold nothing but has an above-average margin: a puzzle.
    expect(cls).toEqual({ Star: "STAR", Plow: "PLOWHORSE", Puzzle: "PUZZLE", Dog: "DOG", "Chicken Curry": "PUZZLE" });
    expect(res.counts).toEqual({ STAR: 1, PLOWHORSE: 1, PUZZLE: 2, DOG: 1 });
    expect(res.rows.find((r) => r.name === "Star")).toMatchObject({ foodCost: 100, contributionMargin: 200, totalMargin: 20000 });
  });
});
