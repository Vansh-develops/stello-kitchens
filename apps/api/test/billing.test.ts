import { afterAll, describe, expect, it, vi } from "vitest";
import type { AuthUser, CreateOrderInput } from "@stello/shared";
import { computeBill, toPaise } from "@stello/shared";
import { PrismaService } from "../src/prisma/prisma.service";
import { OrdersService } from "../src/orders/orders.service";
import { OrderOpsService } from "../src/billing/order-ops.service";
import { ParkedService } from "../src/billing/parked.service";
import { BillingSettingsService } from "../src/billing/billing-settings.service";
import { ReportsService } from "../src/reports/reports.service";
import { testPrisma } from "./db";

const prisma = new PrismaService();
afterAll(() => prisma.$disconnect());
const realtime = { notifyOutlet: vi.fn() };
const orders = new OrdersService(prisma, realtime as any, { verifyAndConsume: vi.fn() } as any);
const ops = new OrderOpsService(prisma, realtime as any, orders);
const parked = new ParkedService(prisma, realtime as any);
const settings = new BillingSettingsService(prisma, realtime as any);
const reports = new ReportsService(prisma);

const today = () => new Date().toISOString().slice(0, 10);
const paise = (n: number) => toPaise(n);

async function fixture(opts: { gstin?: string } = {}) {
  const tenant = await prisma.tenant.create({ data: { name: "Billing" } });
  const role = await prisma.role.create({ data: { tenantId: tenant.id, name: "Owner", permissions: ["*"] } });
  const actor = await prisma.user.create({ data: { tenantId: tenant.id, roleId: role.id, name: "Owner", email: `${tenant.id}@example.com`, passwordHash: "test-only" } });
  const brand = await prisma.brand.create({ data: { tenantId: tenant.id, name: "Brand" } });
  const outlet = await prisma.outlet.create({ data: { tenantId: tenant.id, brandId: brand.id, name: "Outlet", gstin: opts.gstin ?? "29ABCDE1234F2Z4" } });
  const category = await prisma.menuCategory.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Menu" } });
  const mk = (name: string, price: number, taxRate = 5, extra: object = {}) =>
    prisma.item.create({ data: { tenantId: tenant.id, outletId: outlet.id, categoryId: category.id, name, price, taxRate, ...extra } });
  const meal = await mk("Meal", 100);
  const naan = await mk("Naan", 33.33);
  const soda = await mk("Soda", 59, 18);
  const area = await prisma.area.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Floor" } });
  const tables = await Promise.all(
    ["T1", "T2", "T3"].map((name) => prisma.diningTable.create({ data: { tenantId: tenant.id, outletId: outlet.id, areaId: area.id, name } })),
  );
  const user: AuthUser = { id: actor.id, tenantId: tenant.id, email: actor.email, name: "Owner", roleName: "Owner", permissions: ["*"], outletIds: [outlet.id], isPlatformAdmin: false };
  const line = (itemId: string, quantity = 1) => ({ itemId, quantity, addonIds: [] as string[] });
  const dineIn = (tableId: string, items = [line(meal.id)]): CreateOrderInput => ({ outletId: outlet.id, orderType: "DINE_IN", tableId, items, combos: [] });
  const takeaway = (items = [line(meal.id)]): CreateOrderInput => ({ outletId: outlet.id, orderType: "TAKEAWAY", items, combos: [] });
  const setRules = (r: Partial<Parameters<typeof settings.update>[2]> = {}) =>
    settings.update(user, outlet.id, {
      serviceChargeEnabled: false,
      serviceChargePercent: 0,
      serviceChargeTaxable: true,
      serviceChargeOrderTypes: ["DINE_IN"],
      roundOffEnabled: false,
      timezone: "Asia/Kolkata",
      ...r,
    });
  return { tenant, outlet, category, meal, naan, soda, tables, user, line, dineIn, takeaway, setRules, mk };
}

// Hold the contested row so all callers overlap before the first one commits.
async function contend<T>(lock: (tx: any) => Promise<unknown>, jobs: (() => Promise<T>)[]) {
  let unlock!: () => void;
  let ready!: () => void;
  const held = new Promise<void>((resolve) => { ready = resolve; });
  const release = new Promise<void>((resolve) => { unlock = resolve; });
  const blocker = testPrisma.$transaction(async (tx) => { await lock(tx); ready(); await release; });
  await held;
  const pending = Promise.allSettled(jobs.map((job) => job()));
  await new Promise((resolve) => setTimeout(resolve, 200));
  unlock();
  await blocker;
  return pending;
}

describe("service charge + round-off", () => {
  it("applies a taxable dine-in service charge and rounds the payable total", async () => {
    const f = await fixture();
    await f.setRules({ serviceChargeEnabled: true, serviceChargePercent: 10, roundOffEnabled: true });
    const order = await orders.create(f.user, f.dineIn(f.tables[0].id, [f.line(f.meal.id), f.line(f.naan.id)]));
    // 133.33 food; SC 13.33; tax 5% of 146.66 = 7.33; 153.99 → 154.00
    expect(order.serviceChargeAmount).toBe(13.33);
    expect(order.taxAmount).toBe(7.33);
    expect(order.roundOff).toBe(0.01);
    expect(order.total).toBe(154);
    await expect(orders.settle(f.user, order.id, { payments: [{ mode: "CASH", amount: 153.99 }] })).rejects.toThrow("must equal");
    const settled = await orders.settle(f.user, order.id, { payments: [{ mode: "CASH", amount: 100 }, { mode: "UPI", amount: 54 }] });
    expect(settled.status).toBe("SETTLED");
    expect(settled.total).toBe(154);

    const day = await reports.dayEnd(f.user, f.outlet.id, today());
    expect(day.serviceCharge).toBe(13.33);
    expect(day.roundOff).toBe(0.01);
    const breakdown = await reports.breakdown(f.user, f.outlet.id, today(), today());
    expect(breakdown.tax.taxableValue).toBe(146.66); // taxable SC is part of the value of supply
    expect(breakdown.tax.serviceCharge).toBe(13.33);
  });

  it("skips service charge for order types not configured and when non-taxable keeps it out of tax", async () => {
    const f = await fixture();
    await f.setRules({ serviceChargeEnabled: true, serviceChargePercent: 10, serviceChargeTaxable: false });
    const away = await orders.create(f.user, f.takeaway());
    expect(away.serviceChargeAmount).toBe(0);
    expect(away.total).toBe(105);
    const dine = await orders.create(f.user, f.dineIn(f.tables[0].id));
    expect(dine.serviceChargeAmount).toBe(10);
    expect(dine.taxAmount).toBe(5);
    expect(dine.total).toBe(115);
  });

  it("lets permissioned staff remove the service charge with a reason, audited, and restore it", async () => {
    const f = await fixture();
    await f.setRules({ serviceChargeEnabled: true, serviceChargePercent: 10 });
    const order = await orders.create(f.user, f.dineIn(f.tables[0].id));
    expect(order.total).toBe(115.5);
    const waived = await ops.setServiceCharge(f.user, order.id, true, "Guest complaint");
    expect(waived.serviceChargeAmount).toBe(0);
    expect(waived.serviceChargeRemoved).toBe(true);
    expect(waived.serviceChargeRemovedReason).toBe("Guest complaint");
    expect(waived.total).toBe(105);
    // Adding items keeps it waived.
    const more = await orders.addItems(f.user, order.id, { items: [f.line(f.meal.id)], combos: [] });
    expect(more.serviceChargeAmount).toBe(0);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: order.id, action: "SERVICE_CHARGE_REMOVED" } });
    expect(audit.data).toMatchObject({ reason: "Guest complaint", before: 10, after: 0 });
    const restored = await ops.setServiceCharge(f.user, order.id, false);
    expect(restored.serviceChargeAmount).toBe(20);
  });

  it("previews exactly what settlement charges, including discounts", async () => {
    const f = await fixture();
    await f.setRules({ serviceChargeEnabled: true, serviceChargePercent: 7.5, roundOffEnabled: true });
    const order = await orders.create(f.user, f.dineIn(f.tables[0].id, [f.line(f.meal.id, 3), f.line(f.soda.id)]));
    const preview = await orders.preview(f.user, order.id, { discountAmount: 12.5 });
    const settled = await orders.settle(f.user, order.id, { payments: [{ mode: "CARD", amount: preview.total }], discountAmount: 12.5 });
    expect(settled.total).toBe(preview.total);
    expect(settled.serviceChargeAmount).toBe(preview.serviceChargeAmount);
    expect(settled.roundOff).toBe(preview.roundOff);
    expect(paise(preview.total) % 100).toBe(0);
  });

  it("keeps offline-synced settlements on the plain device formula", async () => {
    const f = await fixture();
    await f.setRules({ serviceChargeEnabled: true, serviceChargePercent: 10, serviceChargeOrderTypes: ["TAKEAWAY"], roundOffEnabled: true });
    await prisma.terminal.create({ data: { tenantId: f.tenant.id, outletId: f.outlet.id, name: "Edge", deviceToken: "edge-1" } });
    const res = await orders.applySyncedOrder({
      tenantId: f.tenant.id, outletId: f.outlet.id, deviceId: "edge-1",
      order: { clientId: "c1", orderType: "TAKEAWAY", items: [f.line(f.naan.id)], payments: [{ mode: "CASH", amount: 35 }],
        status: "SETTLED", clientUpdatedAt: new Date().toISOString(), clientVersion: 1 },
    });
    expect(res.status).toBe("applied");
    const saved = await prisma.order.findUniqueOrThrow({ where: { id: res.serverId } });
    expect(Number(saved.total)).toBe(35); // 33.33 + 1.67, no SC / round-off
  });
});

describe("GST place of supply", () => {
  it("reports IGST for an inter-state buyer GSTIN and CGST/SGST otherwise", async () => {
    const f = await fixture({ gstin: "29ABCDE1234F2Z4" });
    const a = await orders.create(f.user, f.takeaway([f.line(f.meal.id, 2)]));
    await orders.settle(f.user, a.id, { payments: [{ mode: "CASH", amount: 210 }] });
    const b = await orders.create(f.user, f.takeaway([f.line(f.meal.id)]));
    const bSettled = await orders.settle(f.user, b.id, { payments: [{ mode: "CASH", amount: 105 }] });
    expect(bSettled.cgst).toBe(2.5);
    expect(bSettled.igst).toBe(0);
    await prisma.invoice.create({
      data: { tenantId: f.tenant.id, outletId: f.outlet.id, orderId: b.id, invoiceNumber: bSettled.billNumber!, buyerGstin: "27AAAAA0000A1Z5", taxableValue: 100, cgst: 0, sgst: 0, igst: 5, total: 105 },
    });
    const dto = await orders.getOne(f.user, b.id);
    expect(dto).toMatchObject({ cgst: 0, sgst: 0, igst: 5 });
    const day = await reports.dayEnd(f.user, f.outlet.id, today());
    expect(day).toMatchObject({ cgst: 5, sgst: 5, igst: 5 });
    const br = await reports.breakdown(f.user, f.outlet.id, today(), today());
    expect(br.tax).toMatchObject({ cgst: 5, sgst: 5, igst: 5, totalTax: 15 });
  });

  it("splits odd-paisa tax without losing a paisa", async () => {
    const f = await fixture();
    const o = await orders.create(f.user, f.takeaway([f.line(f.naan.id)])); // tax 1.67
    expect(o.cgst + o.sgst).toBeCloseTo(1.67, 10);
    expect(paise(o.cgst) + paise(o.sgst)).toBe(167);
  });
});

describe("channel pricing", () => {
  it("charges the channel price for the order's channel and falls back to item.price", async () => {
    const f = await fixture();
    const mkChannel = (name: string, kind = "DIRECT") => prisma.channel.create({ data: { tenantId: f.tenant.id, outletId: f.outlet.id, name, kind } });
    const takeaway = await mkChannel("Takeaway");
    const scan = await mkChannel("Scan & Order");
    const zomato = await mkChannel("Zomato", "AGGREGATOR");
    await prisma.itemChannelPrice.createMany({
      data: [
        { itemId: f.meal.id, channelId: takeaway.id, price: 90 },
        { itemId: f.meal.id, channelId: scan.id, price: 95 },
        { itemId: f.meal.id, channelId: zomato.id, price: 120 },
      ],
    });
    const dine = await orders.create(f.user, f.dineIn(f.tables[0].id));
    expect(dine.items[0].unitPrice).toBe(100); // no dine-in channel price → base
    const away = await orders.create(f.user, f.takeaway([f.line(f.meal.id), f.line(f.naan.id)]));
    expect(away.items.map((i) => i.unitPrice)).toEqual([90, 33.33]);
    const scanned = await orders.ingestScanOrder({ tenantId: f.tenant.id, outletId: f.outlet.id, mode: "DINE_IN", tableId: f.tables[1].id, items: [f.line(f.meal.id)] });
    expect((await orders.getOne(f.user, scanned.orderId)).items[0].unitPrice).toBe(95);
    const agg = await prisma.$transaction((tx) =>
      orders.ingestAggregatorOrderTx(tx, { tenantId: f.tenant.id, outletId: f.outlet.id, items: [f.line(f.meal.id)], channelName: "Zomato" }),
    );
    expect((await orders.getOne(f.user, agg.orderId)).items[0].unitPrice).toBe(120);
  });

  it("carries the channel delta onto variations", async () => {
    const f = await fixture();
    const ch = await prisma.channel.create({ data: { tenantId: f.tenant.id, outletId: f.outlet.id, name: "Delivery" } });
    await prisma.itemChannelPrice.create({ data: { itemId: f.meal.id, channelId: ch.id, price: 110 } });
    const large = await prisma.itemVariation.create({ data: { itemId: f.meal.id, name: "Large", price: 150 } });
    const o = await orders.create(f.user, { ...f.takeaway(), orderType: "DELIVERY", items: [{ ...f.line(f.meal.id), variationId: large.id }] });
    expect(o.items[0].unitPrice).toBe(160);
  });
});

describe("item sale windows", () => {
  const outsideNow = () => {
    // A one-hour window that ended an hour ago, in IST.
    const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
    const h = (ist.getUTCHours() + 22) % 24;
    const hh = (n: number) => String(n).padStart(2, "0") + ":00";
    return { availableStart: hh(h), availableEnd: hh((h + 1) % 24) };
  };

  it("rejects POS and scan punches outside the window and hides the item from diners", async () => {
    const f = await fixture();
    const breakfast = await f.mk("Poha", 60, 5, outsideNow());
    await expect(orders.create(f.user, f.takeaway([f.line(breakfast.id)]))).rejects.toThrow("not available right now");
    await expect(
      orders.ingestScanOrder({ tenantId: f.tenant.id, outletId: f.outlet.id, mode: "TAKEAWAY", items: [f.line(breakfast.id)] }),
    ).rejects.toThrow("not available right now");
    expect(await prisma.order.count()).toBe(0);
    // Tehran (UTC+3:30, no DST) is exactly two hours behind IST, so there the
    // window is open right now: the outlet time zone decides.
    await f.setRules({ timezone: "Asia/Tehran" });
    const ok = await orders.create(f.user, f.takeaway([f.line(breakfast.id)]));
    expect(ok.items[0].itemName).toBe("Poha");
  });

  it("flags rather than rejects offline-synced punches outside the window", async () => {
    const f = await fixture();
    const breakfast = await f.mk("Upma", 50, 0, outsideNow());
    await prisma.terminal.create({ data: { tenantId: f.tenant.id, outletId: f.outlet.id, name: "Edge", deviceToken: "edge-2" } });
    const res = await orders.applySyncedOrder({
      tenantId: f.tenant.id, outletId: f.outlet.id, deviceId: "edge-2",
      order: { clientId: "c2", orderType: "TAKEAWAY", items: [f.line(breakfast.id)], payments: [{ mode: "CASH", amount: 50 }],
        status: "SETTLED", clientUpdatedAt: new Date().toISOString(), clientVersion: 1 },
    });
    expect(res.status).toBe("applied");
    const flag = await prisma.auditLog.findFirstOrThrow({ where: { action: "ORDER_SYNC_AVAILABILITY_FLAG" } });
    expect(flag.data).toMatchObject({ items: ["Upma"] });
  });
});

describe("park / resume", () => {
  it("parks a cart server-side and lets exactly one terminal resume it", async () => {
    const f = await fixture();
    const cart = await parked.park(f.user, f.outlet.id, {
      label: "Sharma — waiting",
      orderType: "TAKEAWAY",
      lines: [{ kind: "item", itemId: f.meal.id, quantity: 2, addonIds: [], name: "Meal", variationName: null, addonNames: [], unitPrice: 100 }],
    });
    expect(cart.amount).toBe(200);
    expect(cart.itemCount).toBe(2);
    expect(await parked.list(f.user, f.outlet.id)).toHaveLength(1);
    const results = await contend(
      (tx) => tx.$queryRaw`SELECT id FROM parked_carts WHERE id = ${cart.id} FOR UPDATE`,
      Array.from({ length: 5 }, () => () => parked.resume(f.user, cart.id)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason.message).toContain("already resumed");
    expect(await parked.list(f.user, f.outlet.id)).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { action: "ORDER_RESUMED" } })).toBe(1);
  });

  it("is tenant and outlet safe", async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(
      parked.park(f.user, f.outlet.id, { label: "x", orderType: "DINE_IN", tableId: other.tables[0].id, lines: [{ kind: "item", itemId: f.meal.id, quantity: 1, addonIds: [], name: "Meal", variationName: null, addonNames: [], unitPrice: 100 }] }),
    ).rejects.toThrow("Table not found");
    const cart = await parked.park(other.user, other.outlet.id, { label: "y", orderType: "TAKEAWAY", lines: [{ kind: "item", itemId: other.meal.id, quantity: 1, addonIds: [], name: "Meal", variationName: null, addonNames: [], unitPrice: 100 }] });
    await expect(parked.resume(f.user, cart.id)).rejects.toThrow("already resumed");
    expect(await parked.list(other.user, other.outlet.id)).toHaveLength(1);
  });
});

describe("merge + transfer", () => {
  it("merges table bills, keeps KOT numbers, frees the source table and audits", async () => {
    const f = await fixture();
    const a = await orders.create(f.user, f.dineIn(f.tables[0].id));
    const b = await orders.create(f.user, f.dineIn(f.tables[1].id, [f.line(f.soda.id, 2)]));
    const merged = await ops.merge(f.user, a.id, { sourceOrderIds: [b.id] });
    expect(merged.items).toHaveLength(2);
    expect(merged.kots.map((k) => k.kotNumber)).toEqual([a.kots[0].kotNumber, b.kots[0].kotNumber]);
    expect(merged.total).toBe(Number((a.total + b.total).toFixed(2)));
    expect((await prisma.order.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("MERGED");
    // Table T2 is free again.
    const reopened = await orders.create(f.user, f.dineIn(f.tables[1].id));
    expect(reopened.tableName).toBe("T2");
    expect(await prisma.auditLog.count({ where: { action: "ORDER_MERGED", entityId: a.id } })).toBe(1);
  });

  it("rejects cross-tenant merges", async () => {
    const f = await fixture();
    const other = await fixture();
    const a = await orders.create(f.user, f.takeaway());
    const b = await orders.create(other.user, other.takeaway());
    await expect(ops.merge(f.user, a.id, { sourceOrderIds: [b.id] })).rejects.toThrow("Order not found");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("OPEN");
  });

  it("moves a whole bill to a free table, and selected quantities to another table", async () => {
    const f = await fixture();
    const a = await orders.create(f.user, f.dineIn(f.tables[0].id, [f.line(f.meal.id, 3), f.line(f.soda.id)]));
    const moved = await ops.transfer(f.user, a.id, { toTableId: f.tables[1].id });
    expect(moved.to.tableName).toBe("T2");
    const mealLine = moved.to.items.find((i) => i.itemName === "Meal")!;
    const partial = await ops.transfer(f.user, a.id, { toTableId: f.tables[2].id, lines: [{ orderItemId: mealLine.id, quantity: 2 }] });
    expect(partial.from!.items.find((i) => i.itemName === "Meal")!.quantity).toBe(1);
    expect(partial.to.items).toHaveLength(1);
    expect(partial.to.items[0]).toMatchObject({ itemName: "Meal", quantity: 2, lineTotal: 200, kotNumber: a.kots[0].kotNumber });
    expect(paise(partial.from!.subtotal) + paise(partial.to.subtotal)).toBe(paise(a.subtotal));
    // Moving the rest of the bill onto an occupied table merges into its bill.
    const rest = await ops.transfer(f.user, a.id, { toTableId: f.tables[2].id });
    expect(rest.from).toBeNull();
    expect(rest.to.id).toBe(partial.to.id);
    expect(paise(rest.to.subtotal)).toBe(paise(a.subtotal));
    expect((await prisma.order.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("MERGED");
  });

  it("serializes competing merges so a bill is folded exactly once", async () => {
    const f = await fixture();
    const a = await orders.create(f.user, f.dineIn(f.tables[0].id));
    const b = await orders.create(f.user, f.dineIn(f.tables[1].id));
    const c = await orders.create(f.user, f.dineIn(f.tables[2].id));
    const results = await contend((tx) => tx.$queryRaw`SELECT id FROM dining_tables WHERE id = ${f.tables[1].id} FOR UPDATE`, [
      () => ops.merge(f.user, a.id, { sourceOrderIds: [b.id] }),
      () => ops.merge(f.user, c.id, { sourceOrderIds: [b.id] }),
      () => ops.merge(f.user, b.id, { sourceOrderIds: [a.id] }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const items = await prisma.orderItem.findMany();
    expect(items).toHaveLength(3); // nothing duplicated or lost
    const open = await prisma.order.findMany({ where: { status: "OPEN" }, include: { items: true } });
    expect(open.reduce((s, o) => s + o.items.length, 0)).toBe(3);
  });

  it("does not merge into a bill that settles concurrently", async () => {
    const f = await fixture();
    const a = await orders.create(f.user, f.dineIn(f.tables[0].id));
    const b = await orders.create(f.user, f.dineIn(f.tables[1].id));
    const results = await contend((tx) => tx.$queryRaw`SELECT id FROM orders WHERE id = ${a.id} FOR UPDATE`, [
      () => orders.settle(f.user, a.id, { payments: [{ mode: "CASH", amount: 105 }] }),
      () => ops.merge(f.user, a.id, { sourceOrderIds: [b.id] }),
    ]);
    const settled = await prisma.order.findUniqueOrThrow({ where: { id: a.id }, include: { items: true } });
    if (results[1].status === "fulfilled") {
      throw new Error("merge into a bill being settled must not both succeed");
    }
    expect(settled.status).toBe("SETTLED");
    expect(settled.items).toHaveLength(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("OPEN");
  });
});

describe("split bills", () => {
  it("splits by items: checks bill their own lines, settle independently, and close the parent", async () => {
    const f = await fixture();
    await f.setRules({ serviceChargeEnabled: true, serviceChargePercent: 10, roundOffEnabled: true });
    const order = await orders.create(f.user, f.dineIn(f.tables[0].id, [f.line(f.meal.id, 2), f.line(f.naan.id, 3), f.line(f.soda.id)]));
    const [meal, naan, soda] = ["Meal", "Naan", "Soda"].map((n) => order.items.find((i) => i.itemName === n)!);
    await expect(
      ops.split(f.user, order.id, { mode: "ITEMS", checks: [{ lines: [{ orderItemId: meal.id, quantity: 2 }] }, { lines: [{ orderItemId: naan.id, quantity: 3 }] }] }),
    ).rejects.toThrow("assign all 1");
    const split = await ops.split(f.user, order.id, {
      mode: "ITEMS",
      discountAmount: 20,
      checks: [
        { lines: [{ orderItemId: meal.id, quantity: 1 }, { orderItemId: naan.id, quantity: 1 }] },
        { lines: [{ orderItemId: meal.id, quantity: 1 }, { orderItemId: naan.id, quantity: 2 }, { orderItemId: soda.id, quantity: 1 }] },
      ],
    });
    expect(split.splitCount).toBe(2);
    expect(split.splitChildren).toHaveLength(2);
    const checks = await Promise.all(split.splitChildren!.map((c) => orders.getOne(f.user, c.id)));
    // Subtotals partition the parent exactly; the discount is allocated pro rata and exactly.
    expect(checks.reduce((s, c) => s + paise(c.subtotal), 0)).toBe(paise(order.subtotal));
    expect(checks.reduce((s, c) => s + paise(c.discountAmount), 0)).toBe(2000);
    for (const c of checks) {
      expect(c.tableName).toBe("T1");
      const lines = await prisma.orderItem.findMany({ where: { orderId: c.id } });
      const expected = computeBill(
        lines.map((l) => ({ lineTotalPaise: paise(Number(l.lineTotal)), taxRatePercent: Number(l.taxRate) })),
        { discountRupees: c.discountAmount, serviceCharge: { percent: 10, taxable: true }, roundOff: true },
      );
      expect(c.total).toBe(expected.total);
      expect(c.taxAmount).toBe(expected.taxAmount);
      expect(c.serviceChargeAmount).toBe(expected.serviceChargeAmount);
    }
    // Parent and checks are frozen for edits; parent can't be settled directly.
    await expect(orders.addItems(f.user, order.id, { items: [f.line(f.meal.id)], combos: [] })).rejects.toThrow("split");
    await expect(orders.settle(f.user, order.id, { payments: [{ mode: "CASH", amount: 1 }] })).rejects.toThrow("settle each check");
    // The kitchen is unaffected: no new KOT lines.
    expect(await prisma.orderItem.count({ where: { kotId: { not: null } } })).toBe(3);

    const s1 = await orders.settle(f.user, checks[0].id, { payments: [{ mode: "CASH", amount: checks[0].total }] });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("OPEN");
    await expect(ops.unsplit(f.user, order.id)).rejects.toThrow("already been settled");
    const s2 = await orders.settle(f.user, checks[1].id, { payments: [{ mode: "UPI", amount: checks[1].total }] });
    expect(s1.billNumber).toBe("B-1");
    expect(s2.billNumber).toBe("B-2");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("SPLIT");
    // The table is free and reports count the two checks, not the parent.
    await orders.create(f.user, f.dineIn(f.tables[0].id));
    const day = await reports.dayEnd(f.user, f.outlet.id, today());
    expect(day.orders).toBe(2);
    expect(day.gross).toBe(Number((checks[0].total + checks[1].total).toFixed(2)));
    const items = await reports.breakdown(f.user, f.outlet.id, today(), today());
    expect(items.topItems.find((i) => i.itemName === "Naan")!.qty).toBe(3);
  });

  it("splits equally with exact per-line paise and balanced checks", async () => {
    const f = await fixture();
    const order = await orders.create(f.user, f.takeaway([f.line(f.meal.id), f.line(f.naan.id), f.line(f.soda.id)]));
    const split = await ops.split(f.user, order.id, { mode: "EQUAL", parts: 3, discountAmount: 10 });
    const checks = await Promise.all(split.splitChildren!.map((c) => orders.getOne(f.user, c.id)));
    expect(checks.reduce((s, c) => s + paise(c.subtotal), 0)).toBe(paise(order.subtotal));
    expect(checks.reduce((s, c) => s + paise(c.discountAmount), 0)).toBe(1000);
    const subtotals = checks.map((c) => paise(c.subtotal));
    expect(Math.max(...subtotals) - Math.min(...subtotals)).toBeLessThanOrEqual(1);
    // Each check's tax is its own invoice's tax; together within a paisa per check of the whole.
    const whole = computeBill(
      [paise(100), paise(33.33), paise(59)].map((p, i) => ({ lineTotalPaise: p, taxRatePercent: [5, 5, 18][i] })),
      { discountRupees: 10 },
    );
    const taxSum = checks.reduce((s, c) => s + paise(c.taxAmount), 0);
    expect(Math.abs(taxSum - paise(whole.taxAmount))).toBeLessThanOrEqual(3);
    expect(checks.every((c) => c.items.every((i) => i.shareParts === 3))).toBe(true);
    for (const c of checks) await orders.settle(f.user, c.id, { payments: [{ mode: "CASH", amount: c.total }] });
    const br = await reports.breakdown(f.user, f.outlet.id, today(), today());
    expect(br.topItems.find((i) => i.itemName === "Meal")!.qty).toBeCloseTo(1, 10);
    expect(br.topItems.find((i) => i.itemName === "Meal")!.revenue).toBe(100);
  });

  it("unsplits while no check has settled", async () => {
    const f = await fixture();
    const order = await orders.create(f.user, f.takeaway([f.line(f.meal.id, 2)]));
    await ops.split(f.user, order.id, { mode: "EQUAL", parts: 2 });
    const back = await ops.unsplit(f.user, order.id);
    expect(back.splitCount).toBeNull();
    expect(await prisma.order.count({ where: { parentOrderId: order.id } })).toBe(0);
    const settled = await orders.settle(f.user, order.id, { payments: [{ mode: "CASH", amount: 210 }] });
    expect(settled.status).toBe("SETTLED");
  });

  it("closes the parent exactly once when the last checks settle concurrently", async () => {
    const f = await fixture();
    const order = await orders.create(f.user, f.takeaway([f.line(f.meal.id, 3)]));
    const split = await ops.split(f.user, order.id, { mode: "EQUAL", parts: 3 });
    const checks = await Promise.all(split.splitChildren!.map((c) => orders.getOne(f.user, c.id)));
    const results = await contend((tx) => tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`,
      // Every check at once, plus a duplicate settle of the first one.
      [...checks, checks[0]].map((c) => () => orders.settle(f.user, c.id, { payments: [{ mode: "CASH", amount: c.total }] })));
    for (const r of results) if (r.status === "rejected") expect(r.reason.message).toBe("Order is not open");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("SPLIT");
    expect(await prisma.auditLog.count({ where: { action: "ORDER_SPLIT_CLOSED", entityId: order.id } })).toBe(1);
    expect(await prisma.orderPayment.count()).toBe(3);
    expect((await prisma.outlet.findUniqueOrThrow({ where: { id: f.outlet.id } })).nextBillNumber).toBe(4);
  });

  it("lets only one of competing split / unsplit / merge win on the same bill", async () => {
    const f = await fixture();
    const a = await orders.create(f.user, f.dineIn(f.tables[0].id, [f.line(f.meal.id, 2)]));
    const b = await orders.create(f.user, f.dineIn(f.tables[1].id));
    const results = await contend((tx) => tx.$queryRaw`SELECT id FROM orders WHERE id = ${a.id} FOR UPDATE`, [
      () => ops.split(f.user, a.id, { mode: "EQUAL", parts: 2 }),
      () => ops.split(f.user, a.id, { mode: "EQUAL", parts: 3 }),
      () => ops.merge(f.user, b.id, { sourceOrderIds: [a.id] }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const children = await prisma.order.count({ where: { parentOrderId: a.id } });
    const parent = await prisma.order.findUniqueOrThrow({ where: { id: a.id } });
    if (parent.status === "MERGED") expect(children).toBe(0);
    else expect(children).toBe(parent.splitCount);
  });

  it("rejects splitting across tenants", async () => {
    const f = await fixture();
    const other = await fixture();
    const order = await orders.create(other.user, other.takeaway());
    await expect(ops.split(f.user, order.id, { mode: "EQUAL", parts: 2 })).rejects.toThrow("Order not found");
  });
});
