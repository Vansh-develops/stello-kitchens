import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { PrismaService } from "../src/prisma/prisma.service";
import { AggregatorSyncService } from "../src/aggregator-sync/aggregator-sync.service";
import { capture, mockHttp, providerFixture, realtimeStub, type Captured } from "./providers-fixture";

const prisma = new PrismaService();
afterAll(() => prisma.$disconnect());
const CONNECTOR = "http://localhost:3003";

let http: ReturnType<typeof mockHttp>;
beforeEach(() => {
  http = mockHttp();
});
afterEach(() => http.restore());

async function setup() {
  const f = await providerFixture(prisma);
  const svc = new AggregatorSyncService(prisma, realtimeStub().gateway as any);
  const channel = await prisma.channel.create({ data: { tenantId: f.tenant.id, outletId: f.outlet.id, name: "UrbanPiper", kind: "AGGREGATOR" } });
  await prisma.itemChannelPrice.create({ data: { itemId: f.item.id, channelId: channel.id, price: 120 } });
  await prisma.aggregatorMenuMap.create({ data: { itemId: f.item.id, channelId: channel.id, externalId: "UP-MEAL" } });
  const agg = await prisma.aggregatorOrder.create({
    data: { tenantId: f.tenant.id, outletId: f.outlet.id, platform: "URBANPIPER", externalOrderId: "3444567", orderValue: 240 },
  });
  return { ...f, svc, agg };
}

it("builds the outbound catalogue with channel price, category and veg flag", async () => {
  const s = await setup();
  expect(await s.svc.catalog("URBANPIPER", s.outlet.id)).toEqual([
    { externalId: "UP-MEAL", title: "Meal", description: null, price: 120, inStock: true, isVeg: true, categoryRef: s.item.categoryId, categoryName: "Menu", outletName: "Outlet" },
  ]);
});

it("relays order accept to the connector, then moves the local status and logs it", async () => {
  const s = await setup();
  const calls: Captured[] = [];
  http.agent.get(CONNECTOR).intercept({ path: "/push/urbanpiper/order-status", method: "POST" })
    .reply(capture(calls, { platform: "URBANPIPER", ok: true, simulated: false, referenceId: null }));
  const res = await s.svc.orderAction(s.user, s.outlet.id, s.agg.id, { status: "ACCEPTED", prepTimeMins: 15 });
  expect(res).toMatchObject({ status: "ACCEPTED", simulated: false });
  expect(calls[0].headers["x-connector-key"]).toBe("dev-connector-key");
  expect(calls[0].body).toEqual({ externalOrderId: "3444567", status: "ACCEPTED", prepTimeMins: 15 });
  expect((await prisma.aggregatorOrder.findUniqueOrThrow({ where: { id: s.agg.id } })).status).toBe("ACCEPTED");
  expect((await s.svc.syncLog(s.user, s.outlet.id))[0]).toMatchObject({ kind: "ORDER_STATUS", status: "OK" });
});

it("keeps the local status when the platform rejects the transition", async () => {
  const s = await setup();
  http.agent.get(CONNECTOR).intercept({ path: "/push/urbanpiper/order-status", method: "POST" }).reply(400, { message: "urbanpiper: err_order_missing_ack" });
  await expect(s.svc.orderAction(s.user, s.outlet.id, s.agg.id, { status: "READY" })).rejects.toThrow("err_order_missing_ack");
  expect((await prisma.aggregatorOrder.findUniqueOrThrow({ where: { id: s.agg.id } })).status).toBe("RECEIVED");
  expect((await s.svc.syncLog(s.user, s.outlet.id))[0]).toMatchObject({ status: "ERROR" });
});

it("auto-pushes only availability changes since the last push", async () => {
  const s = await setup();
  const calls: Captured[] = [];
  http.agent.get(CONNECTOR).intercept({ path: "/push/urbanpiper/stock", method: "POST" }).reply(capture(calls, { ok: true, simulated: true })).times(2);
  expect(await s.svc.autoStockSync(s.outlet.id)).toBe(1); // first sync: everything is new
  expect(await s.svc.autoStockSync(s.outlet.id)).toBe(0); // nothing changed
  await prisma.item.update({ where: { id: s.item.id }, data: { inStock: false } }); // 86 at the POS
  expect(await s.svc.autoStockSync(s.outlet.id)).toBe(1);
  expect(calls[1].body).toEqual({ outletId: s.outlet.id, items: [{ externalId: "UP-MEAL", available: false }] });
});
