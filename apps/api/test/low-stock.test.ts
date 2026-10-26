import { afterAll, expect, it } from "vitest";
import { PrismaService } from "../src/prisma/prisma.service";
import { InventoryService } from "../src/inventory/inventory.service";
import { MessagingService } from "../src/messaging/messaging.service";
import { LoggingSmsTransport, LoggingWhatsAppTransport } from "../src/messaging/transports";
import { LoggingEmailProvider } from "../src/email/email.provider";
import { LowStockService } from "../src/low-stock/low-stock.service";
import { providerFixture, realtimeStub } from "./providers-fixture";

const prisma = new PrismaService();
afterAll(() => prisma.$disconnect());

async function setup() {
  const f = await providerFixture(prisma);
  const rt = realtimeStub();
  let listener: ((outletId: string) => void) | undefined;
  const realtime = { ...rt.gateway, onOutletChanged: (l: (o: string) => void) => (listener = l) };
  const messaging = new MessagingService(prisma, new LoggingSmsTransport(), new LoggingWhatsAppTransport(), new LoggingEmailProvider());
  const lowStock = new LowStockService(prisma, realtime as any, messaging);
  lowStock.onModuleInit(); // subscribes to the post-commit signal (job loops are off under tests)
  const inventory = new InventoryService(prisma, realtime as any);
  await messaging.saveConfig(f.user, {
    smsEnabled: true, whatsappEnabled: true, emailEnabled: true, otpChannel: "SMS", templates: {}, ratePerMinute: 60, lowStockEnabled: true,
    lowStockRecipients: [
      { name: "Chef", phone: "9000000001", channels: ["WHATSAPP", "SMS"] },
      { name: "Owner", email: "owner@example.com", channels: ["EMAIL"] },
    ],
  });
  const material = await prisma.rawMaterial.create({
    data: { tenantId: f.tenant.id, outletId: f.outlet.id, name: "Paneer", unit: "KG", stockQty: 10, reorderLevel: 5 },
  });
  return { ...f, rt, lowStock, inventory, material, fire: (o: string) => listener?.(o) };
}

it("raises exactly one alert per crossing, notifies configured staff and re-arms on replenishment", async () => {
  const s = await setup();
  await s.inventory.recordWastage(s.user, s.outlet.id, s.material.id, { quantity: 6, reason: "spoilt" });
  // Concurrent evaluations (sweep + post-commit signal on several replicas) dedupe to one.
  const results = await Promise.all(Array.from({ length: 5 }, () => s.lowStock.evaluate(s.outlet.id)));
  expect(results.flat()).toHaveLength(1);
  const alert = await prisma.lowStockAlert.findFirstOrThrow();
  expect(alert).toMatchObject({ materialName: "Paneer", notified: 3 });
  expect(Number(alert.stockQty)).toBe(4);
  const queued = await prisma.messageOutbox.findMany({ where: { purpose: "LOW_STOCK" }, orderBy: { channel: "asc" } });
  expect(queued.map((q) => q.channel)).toEqual(["EMAIL", "SMS", "WHATSAPP"]);
  expect(queued[0].vars).toEqual(["Paneer", "4 KG", "5 KG", "Outlet"]);
  expect(s.rt.emit).toHaveBeenCalledWith("inventory:low-stock", expect.objectContaining({ materialName: "Paneer", outletId: s.outlet.id }));

  // Still low: further movements do not re-alert.
  await s.inventory.recordWastage(s.user, s.outlet.id, s.material.id, { quantity: 1 });
  expect(await s.lowStock.evaluate(s.outlet.id)).toHaveLength(0);

  // Replenish above the level (re-arms), then cross again → a second alert.
  await s.inventory.receiveStock(s.user, s.outlet.id, s.material.id, { quantity: 10, unitCost: 300 });
  expect(await s.lowStock.evaluate(s.outlet.id)).toHaveLength(0);
  await s.inventory.recordWastage(s.user, s.outlet.id, s.material.id, { quantity: 9 });
  expect(await s.lowStock.evaluate(s.outlet.id)).toHaveLength(1);
  expect(await prisma.lowStockAlert.count()).toBe(2);
});

it("evaluates right after the post-commit outlet signal, and is tenant-scoped for staff", async () => {
  {
    const s = await setup();
    await prisma.rawMaterial.update({ where: { id: s.material.id }, data: { stockQty: 2 } });
    s.fire(s.outlet.id);
    s.fire(s.outlet.id); // debounced into one evaluation
    for (let i = 0; i < 60 && (await prisma.lowStockAlert.count()) === 0; i++) await new Promise((r) => setTimeout(r, 100));
    const alerts = await s.lowStock.list(s.user, s.outlet.id);
    expect(alerts).toHaveLength(1);
    await s.lowStock.acknowledge(s.user, s.outlet.id, alerts[0].id);
    expect((await s.lowStock.list(s.user, s.outlet.id))[0].acknowledgedAt).toBeTruthy();

    const other = await providerFixture(prisma);
    await expect(s.lowStock.list(other.user, s.outlet.id)).rejects.toThrow("No access");
    s.lowStock.onModuleDestroy();
  }
});
