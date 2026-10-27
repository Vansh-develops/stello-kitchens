import { afterAll, beforeAll, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppModule } from "../src/app.module";
import { hashPin } from "../src/edge/pin";
import { testPrisma } from "./db";

// Contract test: the REAL edge sidecar engine (apps/edge/sidecar/engine.js, SQLite)
// talking HTTP to the REAL API — activation, feed pull, offline billing, push,
// and kitchen-status reconciliation — so the two sides can't drift apart.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { EdgeEngine } = require("../../edge/sidecar/engine.js");

let app: INestApplication;
let base: string;
beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api/v1");
  await app.listen(0, "127.0.0.1");
  base = `${await app.getUrl()}/api/v1`.replace("[::1]", "127.0.0.1");
});
afterAll(async () => {
  await app.close();
});

it("an edge terminal activates, bills offline with its own series and syncs exactly", async () => {
  const tenant = await testPrisma.tenant.create({ data: { name: "Contract", status: "ACTIVE" } });
  const role = await testPrisma.role.create({ data: { tenantId: tenant.id, name: "Owner", permissions: ["*"] } });
  const brand = await testPrisma.brand.create({ data: { tenantId: tenant.id, name: "B" } });
  const outlet = await testPrisma.outlet.create({ data: { tenantId: tenant.id, brandId: brand.id, name: "Contract Outlet", gstin: "29ABCDE1234F1Z5" } });
  const owner = await testPrisma.user.create({
    data: { tenantId: tenant.id, roleId: role.id, name: "Owner", email: "contract-owner@t.test", passwordHash: await bcrypt.hash("pw-contract", 4), userOutlets: { create: [{ outletId: outlet.id }] } },
  });
  await testPrisma.edgeStaffPin.create({ data: { tenantId: tenant.id, userId: owner.id, pinHash: hashPin("2468") } });
  const station = await testPrisma.station.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Hot" } });
  const cat = await testPrisma.menuCategory.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Mains", stationId: station.id } });
  const group = await testPrisma.addonGroup.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Extras", minSelect: 0, maxSelect: 2 } });
  const cheese = await testPrisma.addon.create({ data: { groupId: group.id, name: "Cheese", price: 20 } });
  const roll = await testPrisma.item.create({ data: { tenantId: tenant.id, outletId: outlet.id, categoryId: cat.id, name: "Roll", price: 100, taxRate: 5 } });
  const large = await testPrisma.itemVariation.create({ data: { itemId: roll.id, name: "Large", price: 140 } });
  await testPrisma.itemAddonGroup.create({ data: { itemId: roll.id, addonGroupId: group.id } });
  const cola = await testPrisma.item.create({ data: { tenantId: tenant.id, outletId: outlet.id, categoryId: cat.id, name: "Cola", price: 40, taxRate: 18 } });
  const combo = await testPrisma.combo.create({ data: { tenantId: tenant.id, outletId: outlet.id, categoryId: cat.id, name: "Meal", price: 150, taxRate: 5 } });
  const slot = await testPrisma.comboSlot.create({ data: { comboId: combo.id, name: "Drink" } });
  await testPrisma.comboSlotOption.create({ data: { slotId: slot.id, itemId: cola.id, isDefault: true } });
  const area = await testPrisma.area.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Floor" } });
  const table = await testPrisma.diningTable.create({ data: { tenantId: tenant.id, outletId: outlet.id, areaId: area.id, name: "T7" } });
  await testPrisma.coupon.create({ data: { tenantId: tenant.id, outletId: outlet.id, code: "FLAT10", type: "FLAT", value: 10, usageLimit: 5 } });
  const terminal = await testPrisma.terminal.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Counter", type: "POS" } });

  const engine = new EdgeEngine({ dataDir: mkdtempSync(join(tmpdir(), "edge-contract-")), apiUrl: base, deviceId: terminal.deviceToken });
  try {
    const act = await engine.bootstrap({ email: owner.email, password: "pw-contract" });
    expect(act).toMatchObject({ outletId: outlet.id, seriesCode: "E01", deviceId: terminal.id });
    expect(engine.staffList()).toEqual([expect.objectContaining({ id: owner.id, hasPin: true })]);

    // ---- WAN down: log in by PIN, bill a dine-in table with variant+addon, a combo, a coupon and split payment
    engine.forcedOffline = true;
    const { staff } = await engine.pinLogin(owner.id, "2468");
    const order = engine.createOrder({
      orderType: "DINE_IN",
      tableId: table.id,
      staffId: staff.id,
      items: [{ itemId: roll.id, variationId: large.id, addonIds: [cheese.id], quantity: 2 }],
      combos: [{ comboId: combo.id, quantity: 1, selections: [] }],
    });
    const hot = engine.kdsTickets()[0];
    engine.advanceTicket(hot.id, "READY");
    const subtotal = 2 * 160 + 150; // 470
    const total = Math.round((subtotal - 10) * 1.05 * 100) / 100; // 483
    const settled = engine.settleOrder(order.clientId, {
      couponCode: "flat10",
      payments: [{ mode: "CASH", amount: 400 }, { mode: "UPI", amount: Math.round((total - 400) * 100) / 100, reference: "UTR42" }],
      staffId: staff.id,
    });
    expect(settled.total).toBe(total);
    expect(settled.billNo.number).toMatch(/^E01\/\d{4}\/000001$/);
    await expect(engine.syncOnce()).rejects.toThrow(/offline/);
    expect(engine.pendingCount()).toBe(1);

    // ---- back online: the outbox drains, the cloud files the bill under the device number
    engine.forcedOffline = false;
    const res = await engine.syncOnce();
    expect(res).toMatchObject({ pushed: 1, pending: 0, conflicts: 0 });
    const saved = await testPrisma.order.findFirstOrThrow({ where: { clientId: order.clientId }, include: { items: true, payments: true, kots: true } });
    expect(saved).toMatchObject({ billNumber: settled.billNo.number, status: "SETTLED", tableId: table.id, couponCode: "FLAT10", createdById: owner.id, deviceId: terminal.id });
    expect(Number(saved.total)).toBe(total);
    expect(saved.payments.map((p) => p.mode).sort()).toEqual(["CASH", "UPI"]);
    expect(saved.items.filter((i) => !i.isComboComponent).map((i) => i.prepStatus)).toEqual(["READY", "READY"]);
    expect((await testPrisma.coupon.findFirstOrThrow({ where: { code: "FLAT10" } })).usedCount).toBe(1);

    // ---- a menu change and an 86 reach the device on the next pull
    await testPrisma.item.update({ where: { id: cola.id }, data: { inStock: false, price: 45 } });
    await testPrisma.edgeFeedState.updateMany({ data: { refreshedAt: new Date(0) } });
    await engine.pull();
    const cachedCola = engine.menu().flatMap((c: { items: { id: string }[] }) => c.items).find((i: { id: string }) => i.id === cola.id);
    expect(cachedCola).toMatchObject({ price: 45, inStock: false });

    // ---- a re-sent order is a duplicate, not a second sale
    engine.db.prepare("UPDATE outbox SET status='pending', nextAttemptAt=?").run(new Date(0).toISOString());
    await engine.syncOnce();
    expect(await testPrisma.order.count({ where: { clientId: order.clientId } })).toBe(1);
  } finally {
    engine.close();
  }
});
