import { afterAll, expect, it, vi } from "vitest";
import type { AuthUser, CreateOrderInput } from "@stello/shared";
import { PrismaService } from "../src/prisma/prisma.service";
import { OrdersService } from "../src/orders/orders.service";
import { CashService } from "../src/payments/cash.service";
import { InventoryService } from "../src/inventory/inventory.service";
import { testPrisma } from "./db";

const prisma = new PrismaService();
afterAll(() => prisma.$disconnect());
const realtime = { notifyOutlet: vi.fn() };
const orders = new OrdersService(prisma, realtime as any, { verifyAndConsume: vi.fn() } as any);
const inventory = new InventoryService(prisma, realtime as any);
const gateway = () => ({ name: "test", createUpiQr: vi.fn(), refund: vi.fn(async () => ({ ref: "provider-ref", status: "processed" })) });

async function fixture() {
  const tenant = await prisma.tenant.create({ data: { name: "Integrity" } });
  const role = await prisma.role.create({ data: { tenantId: tenant.id, name: "Owner", permissions: ["*"] } });
  const actor = await prisma.user.create({ data: { tenantId: tenant.id, roleId: role.id, name: "Owner", email: `${tenant.id}@example.com`, passwordHash: "test-only" } });
  const brand = await prisma.brand.create({ data: { tenantId: tenant.id, name: "Brand" } });
  const outlet = await prisma.outlet.create({ data: { tenantId: tenant.id, brandId: brand.id, name: "Outlet" } });
  const category = await prisma.menuCategory.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Menu" } });
  const item = await prisma.item.create({ data: { tenantId: tenant.id, outletId: outlet.id, categoryId: category.id, name: "Meal", price: 100, taxRate: 5 } });
  const area = await prisma.area.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Floor" } });
  const table = await prisma.diningTable.create({ data: { tenantId: tenant.id, outletId: outlet.id, areaId: area.id, name: "T1" } });
  const user: AuthUser = { id: actor.id, tenantId: tenant.id, email: actor.email, name: "Owner", roleName: "Owner", permissions: ["*"], outletIds: [outlet.id], isPlatformAdmin: false };
  const input: CreateOrderInput = { outletId: outlet.id, orderType: "TAKEAWAY", items: [{ itemId: item.id, quantity: 1, addonIds: [] }], combos: [] };
  return { tenant, outlet, item, table, user, input };
}

// Hold the contested row so all callers overlap before the first one commits.
// Parameter values remain bound through Prisma tagged templates.
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

it("records one payment, bill, loyalty earn and audit under 20 competing settlements", async () => {
  const f = await fixture();
  const order = await orders.create(f.user, f.input);
  const results = await contend((tx) => tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`,
    Array.from({ length: 20 }, () => () => orders.settle(f.user, order.id, { payments: [{ mode: "CASH", amount: 105 }], customerPhone: "9999999999" })));
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  for (const r of results) if (r.status === "rejected") expect(r.reason.message).toBe("Order is not open");
  expect(await prisma.orderPayment.count({ where: { orderId: order.id } })).toBe(1);
  expect((await prisma.outlet.findUniqueOrThrow({ where: { id: f.outlet.id } })).nextBillNumber).toBe(2);
  expect(await prisma.auditLog.count({ where: { entityId: order.id, action: "ORDER_SETTLED" } })).toBe(1);
  expect((await prisma.customer.findFirstOrThrow()).totalOrders).toBe(1);
  expect(await prisma.loyaltyTransaction.count()).toBe(1);
});

it("rolls back underpayment and permits a subsequent correct settlement", async () => {
  const f = await fixture();
  const order = await orders.create(f.user, f.input);
  await expect(orders.settle(f.user, order.id, { payments: [{ mode: "CASH", amount: 104.99 }] })).rejects.toThrow("must equal");
  expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("OPEN");
  expect(await prisma.orderPayment.count()).toBe(0);
  const paid = await orders.settle(f.user, order.id, { payments: [{ mode: "CASH", amount: 105 }] });
  expect(paid.billNumber).toBe("B-1");
});

it("does not cancel an order after a concurrent settlement has committed", async () => {
  const f = await fixture();
  const order = await orders.create(f.user, f.input);
  const results = await contend((tx) => tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`, [
    () => orders.settle(f.user, order.id, { payments: [{ mode: "CASH", amount: 105 }] }),
    () => orders.cancel(f.user, order.id),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const saved = await orders.getOne(f.user, order.id);
  expect(saved.payments.length).toBe(saved.status === "SETTLED" ? 1 : 0);
});

it("serializes adding items against settlement without changing a paid bill", async () => {
  const f = await fixture();
  const order = await orders.create(f.user, f.input);
  await contend((tx) => tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`, [
    () => orders.settle(f.user, order.id, { payments: [{ mode: "CASH", amount: 105 }] }),
    () => orders.addItems(f.user, order.id, { items: f.input.items, combos: [] }),
  ]);
  const saved = await orders.getOne(f.user, order.id);
  if (saved.status === "SETTLED") { expect(saved.total).toBe(105); expect(saved.items).toHaveLength(1); }
  else { expect(saved.status).toBe("OPEN"); expect(saved.total).toBe(210); expect(saved.payments).toHaveLength(0); }
});

it("rejects foreign tenant and foreign outlet table references without creating an order", async () => {
  const f = await fixture();
  const other = await fixture();
  await expect(orders.create(f.user, { ...f.input, orderType: "DINE_IN", tableId: other.table.id })).rejects.toThrow("Table not found");
  // A same-tenant table in an unassigned outlet must also be rejected.
  await prisma.diningTable.update({ where: { id: other.table.id }, data: { tenantId: f.tenant.id } });
  await expect(orders.create(f.user, { ...f.input, orderType: "DINE_IN", tableId: other.table.id })).rejects.toThrow("Table not found");
  expect(await prisma.order.count()).toBe(0);
  expect(await prisma.kot.count()).toBe(0);
});

it("opens only one running order for a table under contention", async () => {
  const f = await fixture();
  const results = await contend((tx) => tx.$queryRaw`SELECT id FROM dining_tables WHERE id = ${f.table.id} FOR UPDATE`,
    Array.from({ length: 4 }, () => () => orders.create(f.user, { ...f.input, orderType: "DINE_IN", tableId: f.table.id })));
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  for (const r of results) if (r.status === "rejected") expect(r.reason.message).toBe("Table already has an open order");
  expect(await prisma.order.count({ where: { tableId: f.table.id, status: "OPEN" } })).toBe(1);
});

it("shares table occupancy locking between scan ingestion and staff order creation", async () => {
  const f = await fixture();
  const results = await contend((tx) => tx.$queryRaw`SELECT id FROM dining_tables WHERE id = ${f.table.id} FOR UPDATE`, [
    () => orders.create(f.user, { ...f.input, orderType: "DINE_IN", tableId: f.table.id }),
    () => orders.ingestScanOrder({ tenantId: f.tenant.id, outletId: f.outlet.id, mode: "DINE_IN", tableId: f.table.id, items: f.input.items }) as any,
  ]);
  for (const r of results) if (r.status === "rejected") expect(r.reason.message).toBe("Table already has an open order");
  expect(await prisma.order.count({ where: { tableId: f.table.id, status: "OPEN" } })).toBe(1);
});

async function settledFixture() {
  const f = await fixture();
  const order = await orders.create(f.user, f.input);
  await orders.settle(f.user, order.id, { payments: [{ mode: "CASH", amount: 105 }] });
  const cash = new CashService(prisma, gateway());
  const drawer = await cash.openDrawer(f.user, f.outlet.id, 200);
  return { ...f, order, cash, drawer };
}

it("preserves offline dine-in retry deduplication while enforcing table occupancy", async () => {
  const f = await fixture();
  const payload = { tenantId: f.tenant.id, outletId: f.outlet.id, deviceId: "legacy-test-device",
    order: { clientId: "offline-1", orderType: "DINE_IN" as const, tableId: f.table.id, items: f.input.items,
      payments: [], status: "OPEN" as const, clientUpdatedAt: new Date().toISOString(), clientVersion: 1 } };
  const first = await orders.applySyncedOrder(payload);
  const retry = await orders.applySyncedOrder(payload);
  expect(first.status).toBe("applied");
  expect(retry.status).toBe("duplicate");
  expect(retry.serverId).toBe(first.serverId);
  await expect(orders.create(f.user, { ...f.input, orderType: "DINE_IN", tableId: f.table.id })).rejects.toThrow("Table already has an open order");
});

it("caps cumulative partial refunds at the paid amount and records the exact cash outflow", async () => {
  const f = await settledFixture();
  await f.cash.refund(f.user, f.outlet.id, f.order.id, { amount: 60, mode: "CASH" });
  await expect(f.cash.refund(f.user, f.outlet.id, f.order.id, { amount: 46, mode: "CASH" })).rejects.toThrow("remaining refundable balance");
  await f.cash.refund(f.user, f.outlet.id, f.order.id, { amount: 45, mode: "CASH" });
  expect(Number((await prisma.refund.aggregate({ _sum: { amount: true } }))._sum.amount)).toBe(105);
  expect(Number((await prisma.cashMovement.aggregate({ _sum: { amount: true } }))._sum.amount)).toBe(-105);
});

it("accepts only one of competing full refunds", async () => {
  const f = await settledFixture();
  const results = await contend((tx) => tx.$queryRaw`SELECT id FROM orders WHERE id = ${f.order.id} FOR UPDATE`,
    Array.from({ length: 4 }, () => () => f.cash.refund(f.user, f.outlet.id, f.order.id, { amount: 105, mode: "CASH" })));
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  for (const r of results) if (r.status === "rejected") expect(r.reason.message).toContain("remaining refundable balance");
  expect(await prisma.refund.count()).toBe(1);
  expect(await prisma.cashMovement.count({ where: { type: "REFUND" } })).toBe(1);
});

it("deduplicates refund retries and rejects key reuse with different details", async () => {
  const f = await settledFixture();
  const input = { amount: 25, mode: "CASH" as const, requestKey: "cashier-operation-1" };
  const first = await f.cash.refund(f.user, f.outlet.id, f.order.id, input);
  const retry = await f.cash.refund(f.user, f.outlet.id, f.order.id, input);
  expect(retry.id).toBe(first.id);
  await expect(f.cash.refund(f.user, f.outlet.id, f.order.id, { ...input, amount: 30 })).rejects.toThrow("different details");
  expect(await prisma.refund.count()).toBe(1);
  expect(await prisma.cashMovement.count()).toBe(1);
});

it("reserves uncertain provider refunds and never resends them on API retry", async () => {
  const f = await settledFixture();
  const provider = gateway();
  provider.refund.mockRejectedValue(new Error("Connection lost after provider processed request"));
  const cash = new CashService(prisma, provider);
  const input = { amount: 105, mode: "UPI" as const, requestKey: "upi-operation-1" };
  expect((await cash.refund(f.user, f.outlet.id, f.order.id, input)).status).toBe("UNKNOWN");
  expect((await cash.refund(f.user, f.outlet.id, f.order.id, input)).status).toBe("UNKNOWN");
  expect(provider.refund).toHaveBeenCalledTimes(1);
  await expect(cash.refund(f.user, f.outlet.id, f.order.id, { amount: 1, mode: "CASH" })).rejects.toThrow("remaining refundable balance");
});

it("rejects invalid refund amounts and cross-tenant access", async () => {
  const f = await settledFixture();
  for (const amount of [-1, 0, 0.001, NaN, Infinity]) {
    await expect(f.cash.refund(f.user, f.outlet.id, f.order.id, { amount, mode: "CASH" })).rejects.toThrow("whole paise");
  }
  await expect(f.cash.refund({ ...f.user, tenantId: "foreign" }, f.outlet.id, f.order.id, { amount: 1, mode: "CASH" })).rejects.toThrow("Order not found");
  expect(await prisma.refund.count()).toBe(0);
});

it("rolls back the refund if its cash movement cannot be written", async () => {
  const f = await settledFixture();
  await testPrisma.$executeRawUnsafe(`CREATE FUNCTION fail_refund_movement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type = 'REFUND' THEN RAISE EXCEPTION 'test movement failure'; END IF; RETURN NEW; END $$`);
  await testPrisma.$executeRawUnsafe(`CREATE TRIGGER fail_refund BEFORE INSERT ON cash_movements FOR EACH ROW EXECUTE FUNCTION fail_refund_movement()`);
  try {
    await expect(f.cash.refund(f.user, f.outlet.id, f.order.id, { amount: 10, mode: "CASH" })).rejects.toThrow();
    expect(await prisma.refund.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "REFUND_RESERVED" } })).toBe(0);
  } finally {
    await testPrisma.$executeRawUnsafe("DROP TRIGGER fail_refund ON cash_movements");
    await testPrisma.$executeRawUnsafe("DROP FUNCTION fail_refund_movement()");
  }
});

it("preserves concurrent receipts and their weighted-average value", async () => {
  const f = await fixture();
  const material = await prisma.rawMaterial.create({ data: { tenantId: f.tenant.id, outletId: f.outlet.id, name: "Rice", unit: "KG", stockQty: 10, costPerUnit: 10 } });
  const results = await contend((tx) => tx.$queryRaw`SELECT id FROM raw_materials WHERE id = ${material.id} FOR UPDATE`, [
    () => inventory.receiveStock(f.user, f.outlet.id, material.id, { quantity: 5, unitCost: 20 }),
    () => inventory.receiveStock(f.user, f.outlet.id, material.id, { quantity: 5, unitCost: 30 }),
  ]);
  expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  const saved = await prisma.rawMaterial.findUniqueOrThrow({ where: { id: material.id } });
  expect(Number(saved.stockQty)).toBe(20);
  expect(Number(saved.costPerUnit)).toBeCloseTo(17.5, 3);
  expect(await prisma.stockMovement.count()).toBe(2);
});

it("preserves quantity when receiving and recording waste concurrently", async () => {
  const f = await fixture();
  const material = await prisma.rawMaterial.create({ data: { tenantId: f.tenant.id, outletId: f.outlet.id, name: "Rice", unit: "KG", stockQty: 10, costPerUnit: 10 } });
  const results = await contend((tx) => tx.$queryRaw`SELECT id FROM raw_materials WHERE id = ${material.id} FOR UPDATE`, [
    () => inventory.receiveStock(f.user, f.outlet.id, material.id, { quantity: 5, unitCost: 10 }),
    () => inventory.recordWastage(f.user, f.outlet.id, material.id, { quantity: 2 }),
  ]);
  expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  expect(Number((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: material.id } })).stockQty)).toBe(13);
  expect(Number((await prisma.stockMovement.aggregate({ _sum: { quantity: true } }))._sum.quantity)).toBe(3);
});

it("rejects receiving against a foreign vendor without changing stock", async () => {
  const f = await fixture();
  const foreign = await fixture();
  const vendor = await prisma.vendor.create({ data: { tenantId: foreign.tenant.id, outletId: foreign.outlet.id, name: "Private" } });
  const material = await prisma.rawMaterial.create({ data: { tenantId: f.tenant.id, outletId: f.outlet.id, name: "Rice", unit: "KG", stockQty: 10 } });
  await expect(inventory.receiveStock(f.user, f.outlet.id, material.id, { quantity: 5, unitCost: 10, vendorId: vendor.id })).rejects.toThrow("Vendor not found");
  expect(Number((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: material.id } })).stockQty)).toBe(10);
  expect(await prisma.stockMovement.count()).toBe(0);
});

it("enforces modifier minimum, maximum, uniqueness and valid pricing", async () => {
  const f = await fixture();
  const group = await prisma.addonGroup.create({ data: { tenantId: f.tenant.id, outletId: f.outlet.id, name: "Sides", minSelect: 1, maxSelect: 1, addons: { create: [{ name: "A", price: 10 }, { name: "B", price: 20 }] } }, include: { addons: true } });
  await prisma.itemAddonGroup.create({ data: { itemId: f.item.id, addonGroupId: group.id } });
  const [a, b] = group.addons;
  for (const addonIds of [[], [a.id, a.id], [a.id, b.id], ["foreign-addon"]]) {
    await expect(orders.create(f.user, { ...f.input, items: [{ ...f.input.items[0], addonIds }] })).rejects.toThrow();
  }
  expect(await prisma.order.count()).toBe(0);
  const order = await orders.create(f.user, { ...f.input, items: [{ ...f.input.items[0], addonIds: [a.id] }] });
  expect(order.total).toBe(115.5);
});
