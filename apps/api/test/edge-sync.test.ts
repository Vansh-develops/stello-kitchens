import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { JwtService } from "@nestjs/jwt";
import type { EdgeFeedDto, EdgeOrderInput, EdgePushResultDto } from "@stello/shared";
import { AppModule } from "../src/app.module";
import { EdgeFeedService } from "../src/edge/edge-feed.service";
import { hashPin, verifyPin } from "../src/edge/pin";
import { testPrisma } from "./db";

// End-to-end over HTTP: device activation (user JWT + permission), the
// device-authenticated change feed and outbox ingest, and the console views.
let app: INestApplication;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api/v1");
  await app.init();
});
afterAll(async () => {
  await app.close();
});

async function tenantFixture(label: string) {
  const passwordHash = "unused";
  const tenant = await testPrisma.tenant.create({ data: { name: label, status: "ACTIVE" } });
  const owner = await testPrisma.role.create({ data: { tenantId: tenant.id, name: "Owner", permissions: ["*"] } });
  const cashierRole = await testPrisma.role.create({ data: { tenantId: tenant.id, name: "Cashier", permissions: ["orders.create", "orders.settle"] } });
  const brand = await testPrisma.brand.create({ data: { tenantId: tenant.id, name: label } });
  const outlet = await testPrisma.outlet.create({ data: { tenantId: tenant.id, brandId: brand.id, name: `${label} Main` } });
  const outlet2 = await testPrisma.outlet.create({ data: { tenantId: tenant.id, brandId: brand.id, name: `${label} Second` } });
  const admin = await testPrisma.user.create({
    data: { tenantId: tenant.id, roleId: owner.id, name: "Owner", email: `owner-${tenant.id}@t.test`, passwordHash, userOutlets: { create: [{ outletId: outlet.id }, { outletId: outlet2.id }] } },
  });
  const cashier = await testPrisma.user.create({
    data: { tenantId: tenant.id, roleId: cashierRole.id, name: "Cashier", email: `cashier-${tenant.id}@t.test`, passwordHash, userOutlets: { create: [{ outletId: outlet.id }] } },
  });
  const station = await testPrisma.station.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Hot" } });
  const category = await testPrisma.menuCategory.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Mains", stationId: station.id } });
  const item = await testPrisma.item.create({ data: { tenantId: tenant.id, outletId: outlet.id, categoryId: category.id, name: "Paneer Roll", price: 100, taxRate: 5 } });
  const side = await testPrisma.item.create({ data: { tenantId: tenant.id, outletId: outlet.id, categoryId: category.id, name: "Fries", price: 60, taxRate: 5 } });
  const area = await testPrisma.area.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Floor" } });
  const table = await testPrisma.diningTable.create({ data: { tenantId: tenant.id, outletId: outlet.id, areaId: area.id, name: "T1" } });
  const otherCat = await testPrisma.menuCategory.create({ data: { tenantId: tenant.id, outletId: outlet2.id, name: "Other outlet" } });
  await testPrisma.item.create({ data: { tenantId: tenant.id, outletId: outlet2.id, categoryId: otherCat.id, name: "Second outlet only", price: 10 } });
  const terminal = await testPrisma.terminal.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Counter", type: "POS" } });
  const terminal2 = await testPrisma.terminal.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Counter 2", type: "POS" } });
  // Sign session tokens directly: the login route is rate-limited to a handful per minute.
  const jwt = app.get(JwtService);
  const login = (u: { id: string; tenantId: string }) => jwt.signAsync({ sub: u.id, tenantId: u.tenantId, tokenVersion: 0 });
  return { tenant, outlet, outlet2, admin, cashier, category, item, side, table, terminal, terminal2, adminToken: await login(admin), cashierToken: await login(cashier) };
}
type Fx = Awaited<ReturnType<typeof tenantFixture>>;

async function activate(f: Fx, terminalRef: string) {
  const res = await http().post(`/api/v1/outlets/${f.outlet.id}/edge/activate`).set("authorization", `Bearer ${f.adminToken}`).send({ terminalRef }).expect(201);
  return res.body as { edgeDeviceId: string; deviceToken: string; seriesCode: string };
}
const device = (token: string) => ({ authorization: `Device ${token}` });

async function pullAll(token: string, cursor = "0") {
  // Bypass the refresh throttle so each pull sees the latest catalog.
  await testPrisma.edgeFeedState.updateMany({ data: { refreshedAt: new Date(0) } });
  const res = await http().get(`/api/v1/edge/device/feed?cursor=${cursor}`).set(device(token)).expect(200);
  return res.body as EdgeFeedDto;
}

function settledOrder(f: Fx, clientId: string, seq: number, series: string, over: Partial<EdgeOrderInput> = {}): EdgeOrderInput {
  return {
    clientId,
    orderType: "TAKEAWAY",
    items: [{ itemId: f.item.id, quantity: 2, addonIds: [], unitPrice: 100, taxRate: 5, prepStatus: "READY", preppedAt: new Date().toISOString() }],
    combos: [],
    status: "SETTLED",
    payments: [{ mode: "CASH", amount: 110 }, { mode: "UPI", amount: 100, reference: "UTR1" }],
    manualDiscount: 0,
    couponCode: null,
    couponDiscount: 0,
    subtotal: 200,
    taxAmount: 10,
    total: 210,
    billNo: { series, fy: "2627", seq, number: `${series}/2627/${String(seq).padStart(6, "0")}` },
    createdAt: new Date().toISOString(),
    closedAt: new Date().toISOString(),
    createdByStaffId: f.cashier.id,
    closedByStaffId: f.cashier.id,
    ...over,
  };
}
async function push(token: string, orders: EdgeOrderInput[], deviceTime = new Date().toISOString()) {
  const res = await http()
    .post("/api/v1/edge/device/push")
    .set(device(token))
    .send({ deviceTime, ops: orders.map((order) => ({ kind: "ORDER", key: order.clientId, order })) })
    .expect(201);
  return res.body as EdgePushResultDto;
}

describe("edge PIN hashing", () => {
  it("verifies its own hashes and the sidecar's wire format", () => {
    const h = hashPin("4821");
    expect(verifyPin("4821", h)).toBe(true);
    expect(verifyPin("4822", h)).toBe(false);
    // Vector produced by apps/edge/sidecar/pin.js (format parity check).
    const vector = "scrypt$16384$8$1$AAECAwQFBgcICQoLDA0ODw$WN-87vPtGO4o1fwEttloKNIwtqGZqnsfkSCWNJhrpMg";
    expect(verifyPin("1234", vector)).toBe(true);
    expect(verifyPin("1235", vector)).toBe(false);
  });
});

describe("edge device activation + auth", () => {
  it("requires edge.activate, binds to a provisioned terminal and issues a fresh series on re-activation", async () => {
    const f = await tenantFixture("Act");
    await http().post(`/api/v1/outlets/${f.outlet.id}/edge/activate`).set("authorization", `Bearer ${f.cashierToken}`).send({ terminalRef: f.terminal.id }).expect(403);
    await http().post(`/api/v1/outlets/${f.outlet.id}/edge/activate`).set("authorization", `Bearer ${f.adminToken}`).send({ terminalRef: "nope" }).expect(404);

    const first = await activate(f, f.terminal.deviceToken); // EDGE_DEVICE_ID may be the deviceToken
    expect(first.seriesCode).toBe("E01");
    expect(first.deviceToken).toMatch(/^edk_/);
    await http().get("/api/v1/edge/device/feed").set(device(first.deviceToken)).expect(200);

    const again = await activate(f, f.terminal.id);
    expect(again.seriesCode).toBe("E02");
    // The previous activation is revoked; the new one works.
    await http().get("/api/v1/edge/device/feed").set(device(first.deviceToken)).expect(401);
    await http().get("/api/v1/edge/device/feed").set(device(again.deviceToken)).expect(200);
  });

  it("rejects missing, forged, user-JWT and deactivated-terminal credentials", async () => {
    const f = await tenantFixture("Auth");
    const act = await activate(f, f.terminal.id);
    await http().get("/api/v1/edge/device/feed").expect(401);
    await http().get("/api/v1/edge/device/feed").set("authorization", `Bearer ${f.adminToken}`).expect(401);
    const forged = act.deviceToken.replace(/\.(.)/, (_m, c) => `.${c === "A" ? "B" : "A"}`);
    await http().get("/api/v1/edge/device/feed").set(device(forged)).expect(401);
    await testPrisma.terminal.update({ where: { id: f.terminal.id }, data: { isActive: false } });
    await http().get("/api/v1/edge/device/feed").set(device(act.deviceToken)).expect(403);
    await testPrisma.terminal.update({ where: { id: f.terminal.id }, data: { isActive: true } });
    await testPrisma.tenant.update({ where: { id: f.tenant.id }, data: { status: "SUSPENDED" } });
    await http().get("/api/v1/edge/device/feed").set(device(act.deviceToken)).expect(403);
  });
});

describe("edge change feed", () => {
  it("is scoped to the device's outlet and tenant", async () => {
    const f = await tenantFixture("ScopeA");
    const g = await tenantFixture("ScopeB");
    await testPrisma.edgeStaffPin.create({ data: { tenantId: f.tenant.id, userId: f.cashier.id, pinHash: hashPin("1111") } });
    const act = await activate(f, f.terminal.id);
    const feed = await pullAll(act.deviceToken);
    const items = feed.changes.filter((c) => c.entity === "item").map((c) => (c.data as { name: string }).name).sort();
    expect(items).toEqual(["Fries", "Paneer Roll"]); // not the second outlet's, not tenant B's
    expect(feed.changes.some((c) => JSON.stringify(c.data ?? {}).includes(g.tenant.name))).toBe(false);
    const staff = feed.changes.filter((c) => c.entity === "staff").map((c) => c.data as { id: string; pinHash: string | null });
    expect(staff.map((s) => s.id).sort()).toEqual([f.admin.id, f.cashier.id].sort());
    expect(staff.find((s) => s.id === f.cashier.id)!.pinHash).toMatch(/^scrypt\$/);
    expect(feed.changes.find((c) => c.entity === "settings")).toBeTruthy();
    expect(feed.changes.find((c) => c.entity === "table")).toBeTruthy();
  });

  it("serves only changes after the cursor, with tombstones, and resets a cursor from the future", async () => {
    const f = await tenantFixture("Incr");
    const act = await activate(f, f.terminal.id);
    const first = await pullAll(act.deviceToken);
    const quiet = await pullAll(act.deviceToken, first.cursor);
    expect(quiet.changes).toHaveLength(0);
    expect(quiet.cursor).toBe(first.cursor);

    await testPrisma.item.update({ where: { id: f.item.id }, data: { price: 120, inStock: false } }); // reprice + 86
    await testPrisma.item.update({ where: { id: f.side.id }, data: { deletedAt: new Date() } });
    const delta = await pullAll(act.deviceToken, first.cursor);
    expect(delta.changes.map((c) => `${c.entity}:${c.op}`).sort()).toEqual(["item:delete", "item:upsert"]);
    const repriced = delta.changes.find((c) => c.op === "upsert")!.data as { price: number; inStock: boolean };
    expect(repriced).toMatchObject({ price: 120, inStock: false });
    expect(Number(delta.cursor)).toBeGreaterThan(Number(first.cursor));

    const ahead = await pullAll(act.deviceToken, "999999");
    expect(ahead.reset).toBe(true);
    expect(ahead.changes.length).toBeGreaterThan(0);
  });

  it("pages and keeps sequence numbers unique under concurrent refreshes", async () => {
    const f = await tenantFixture("Conc");
    const feedSvc = app.get(EdgeFeedService);
    for (let i = 0; i < 5; i++) {
      await testPrisma.item.create({ data: { tenantId: f.tenant.id, outletId: f.outlet.id, categoryId: f.category.id, name: `Bulk ${i}`, price: 10 + i } });
    }
    await Promise.all([feedSvc.refresh(f.tenant.id, f.outlet.id, 0), feedSvc.refresh(f.tenant.id, f.outlet.id, 0), feedSvc.refresh(f.tenant.id, f.outlet.id, 0)]);
    const entries = await testPrisma.edgeFeedEntry.findMany({ where: { outletId: f.outlet.id } });
    expect(new Set(entries.map((e) => e.seq)).size).toBe(entries.length);
    const act = await activate(f, f.terminal.id);
    const page = (await http().get(`/api/v1/edge/device/feed?cursor=0&limit=3`).set(device(act.deviceToken)).expect(200)).body as EdgeFeedDto;
    expect(page.changes).toHaveLength(3);
    expect(page.hasMore).toBe(true);
  });
});

describe("edge outbox ingest", () => {
  it("applies an offline sale with its device invoice number and reports retries as duplicates", async () => {
    const f = await tenantFixture("Ingest");
    const act = await activate(f, f.terminal.id);
    const order = settledOrder(f, "c-1", 1, act.seriesCode);
    const res = await push(act.deviceToken, [order]);
    expect(res.results[0]).toMatchObject({ status: "applied", billNumber: "E01/2627/000001" });
    const saved = await testPrisma.order.findFirstOrThrow({ where: { clientId: "c-1" }, include: { payments: true, items: true, kots: true } });
    expect(saved).toMatchObject({ status: "SETTLED", billNumber: "E01/2627/000001", createdById: f.cashier.id, deviceId: f.terminal.id });
    expect(Number(saved.total)).toBe(210);
    expect(saved.payments).toHaveLength(2);
    expect(saved.items[0].prepStatus).toBe("READY"); // LAN KDS already served it — cloud KDS won't re-show it
    expect(saved.kots[0].status).toBe("READY");
    expect((await testPrisma.outlet.findUniqueOrThrow({ where: { id: f.outlet.id } })).nextBillNumber).toBe(1); // online series untouched

    const again = await push(act.deviceToken, [order]);
    expect(again.results[0]).toMatchObject({ status: "duplicate", serverId: saved.id, billNumber: "E01/2627/000001" });
    expect(await testPrisma.order.count({ where: { clientId: "c-1" } })).toBe(1);
  });

  it("flags a limited coupon redeemed on two offline devices beyond its limit but keeps both sales", async () => {
    const f = await tenantFixture("Coupon");
    await testPrisma.coupon.create({ data: { tenantId: f.tenant.id, outletId: f.outlet.id, code: "ONCE", type: "FLAT", value: 20, usageLimit: 1 } });
    const a = await activate(f, f.terminal.id);
    const b = await activate(f, f.terminal2.id);
    // 200 − 20 = 180 taxable, 5% → 9 tax, 189 total.
    const withCoupon = (id: string, series: string) =>
      settledOrder(f, id, 1, series, { couponCode: "ONCE", couponDiscount: 20, taxAmount: 9, total: 189, payments: [{ mode: "CARD", amount: 189 }] });
    const r1 = await push(a.deviceToken, [withCoupon("ca", a.seriesCode)]);
    const r2 = await push(b.deviceToken, [withCoupon("cb", b.seriesCode)]);
    expect(r1.results[0].status).toBe("applied");
    expect(r2.results[0].status).toBe("conflict");
    expect(r2.results[0].conflicts![0].kind).toBe("COUPON_LIMIT_EXCEEDED");
    expect((await testPrisma.coupon.findFirstOrThrow({ where: { code: "ONCE" } })).usedCount).toBe(2);
    expect(await testPrisma.order.count({ where: { couponCode: "ONCE", status: "SETTLED" } })).toBe(2);

    const list = await http().get(`/api/v1/outlets/${f.outlet.id}/edge/conflicts?status=OPEN`).set("authorization", `Bearer ${f.adminToken}`).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ kind: "COUPON_LIMIT_EXCEEDED", seriesCode: b.seriesCode, billNumber: `${b.seriesCode}/2627/000001` });
    await http().post(`/api/v1/outlets/${f.outlet.id}/edge/conflicts/${list.body[0].id}/resolve`).set("authorization", `Bearer ${f.cashierToken}`).send({ note: "ok" }).expect(403);
    await http().post(`/api/v1/outlets/${f.outlet.id}/edge/conflicts/${list.body[0].id}/resolve`).set("authorization", `Bearer ${f.adminToken}`).send({ note: "Goodwill" }).expect(201);
    const open = await http().get(`/api/v1/outlets/${f.outlet.id}/edge/conflicts?status=OPEN`).set("authorization", `Bearer ${f.adminToken}`).expect(200);
    expect(open.body).toHaveLength(0);
  });

  it("keeps sales billed at cached prices for 86'd items, flagging drift and unknown staff", async () => {
    const f = await tenantFixture("Drift");
    const act = await activate(f, f.terminal.id);
    await testPrisma.item.update({ where: { id: f.item.id }, data: { price: 150, inStock: false } });
    const res = await push(act.deviceToken, [settledOrder(f, "d-1", 1, act.seriesCode, { closedByStaffId: "ghost" })]);
    expect(res.results[0].status).toBe("conflict");
    expect(res.results[0].conflicts!.map((c) => c.kind).sort()).toEqual(["PRICE_DRIFT", "STAFF_UNKNOWN"]);
    const saved = await testPrisma.order.findFirstOrThrow({ where: { clientId: "d-1" }, include: { items: true } });
    expect(Number(saved.items[0].unitPrice)).toBe(100);
    expect(Number(saved.total)).toBe(210);
  });

  it("rejects an order whose figures do not add up and records it for review", async () => {
    const f = await tenantFixture("Reject");
    const act = await activate(f, f.terminal.id);
    const res = await push(act.deviceToken, [settledOrder(f, "r-1", 1, act.seriesCode, { total: 200, payments: [{ mode: "CASH", amount: 200 }] })]);
    expect(res.results[0].status).toBe("rejected");
    expect(await testPrisma.order.count({ where: { clientId: "r-1" } })).toBe(0);
    const c = await testPrisma.edgeSyncConflict.findFirstOrThrow({ where: { clientId: "r-1" } });
    expect(c.kind).toBe("REJECTED");
    expect((c.detail as { order: { clientId: string } }).order.clientId).toBe("r-1");
  });

  it("refuses a foreign series, never reuses a number, and reports gaps", async () => {
    const f = await tenantFixture("Series");
    const a = await activate(f, f.terminal.id);
    const b = await activate(f, f.terminal2.id);
    // Device A claims device B's series → fallback outlet number + conflict.
    const stolen = await push(a.deviceToken, [settledOrder(f, "s-0", 1, b.seriesCode)]);
    expect(stolen.results[0].status).toBe("conflict");
    expect(stolen.results[0].billNumber).toBe("B-1");
    expect(stolen.results[0].conflicts![0].kind).toBe("BILL_SERIES_MISMATCH");

    await push(a.deviceToken, [settledOrder(f, "s-1", 1, a.seriesCode), settledOrder(f, "s-3", 3, a.seriesCode)]);
    const dup = await push(a.deviceToken, [settledOrder(f, "s-dup", 3, a.seriesCode)]);
    expect(dup.results[0].conflicts![0].kind).toBe("BILL_NUMBER_DUPLICATE");
    expect(dup.results[0].billNumber).toBe("B-2");

    const series = await http().get(`/api/v1/outlets/${f.outlet.id}/edge/series`).set("authorization", `Bearer ${f.adminToken}`).expect(200);
    expect(series.body).toEqual([expect.objectContaining({ seriesCode: a.seriesCode, fiscalYear: "2627", count: 2, lastSeq: 3, missing: [2] })]);
  });

  it("corrects sale times for device clock skew and reconciles later KOT status", async () => {
    const f = await tenantFixture("Skew");
    const act = await activate(f, f.terminal.id);
    const hourAhead = (d: Date) => new Date(d.getTime() + 3600_000).toISOString();
    const now = new Date();
    const order = settledOrder(f, "k-1", 1, act.seriesCode, {
      createdAt: hourAhead(new Date(now.getTime() - 600_000)),
      closedAt: hourAhead(now),
      items: [{ itemId: f.item.id, quantity: 2, addonIds: [], unitPrice: 100, taxRate: 5, prepStatus: "PENDING" }],
    });
    const res = await push(act.deviceToken, [order], hourAhead(now));
    expect(Math.abs(res.clockSkewMs + 3600_000)).toBeLessThan(5000);
    expect(res.results[0].conflicts!.map((c) => c.kind)).toEqual(["CLOCK_SKEW"]);
    const saved = await testPrisma.order.findFirstOrThrow({ where: { clientId: "k-1" }, include: { kots: true } });
    expect(Math.abs(saved.createdAt.getTime() - (now.getTime() - 600_000))).toBeLessThan(5000);
    expect(saved.kots[0].status).toBe("PENDING");

    const ks = await http()
      .post("/api/v1/edge/device/push")
      .set(device(act.deviceToken))
      .send({ deviceTime: new Date().toISOString(), ops: [{ kind: "KOT_STATUS", key: "k-1:ready", clientId: "k-1", lines: [{ lineIndex: 0, kind: "item", prepStatus: "READY" }] }] })
      .expect(201);
    expect(ks.body.results[0].status).toBe("applied");
    const after = await testPrisma.order.findFirstOrThrow({ where: { clientId: "k-1" }, include: { kots: true, items: true } });
    expect(after.items[0].prepStatus).toBe("READY");
    expect(after.kots[0].status).toBe("READY");

    const early = await http()
      .post("/api/v1/edge/device/push")
      .set(device(act.deviceToken))
      .send({ deviceTime: new Date().toISOString(), ops: [{ kind: "KOT_STATUS", key: "x", clientId: "not-synced", lines: [{ lineIndex: 0, kind: "item", prepStatus: "READY" }] }] })
      .expect(201);
    expect(early.body.results[0].status).toBe("retry");
  });

  it("does not let a device push into another tenant's outlet or reference its catalog", async () => {
    const f = await tenantFixture("IsoA");
    const g = await tenantFixture("IsoB");
    const act = await activate(f, f.terminal.id);
    const foreign = settledOrder(f, "iso-1", 1, act.seriesCode, {
      items: [{ itemId: g.item.id, quantity: 2, addonIds: [], unitPrice: 100, taxRate: 5, prepStatus: "PENDING" }],
    });
    const res = await push(act.deviceToken, [foreign]);
    expect(res.results[0].status).toBe("rejected");
    expect(await testPrisma.order.count({ where: { outletId: g.outlet.id } })).toBe(0);
  });
});

describe("edge staff PINs", () => {
  it("lets edge.manage set and clear PINs for outlet staff only", async () => {
    const f = await tenantFixture("Pins");
    const g = await tenantFixture("PinsOther");
    const base = `/api/v1/outlets/${f.outlet.id}/edge/staff`;
    await http().put(`${base}/${f.cashier.id}/pin`).set("authorization", `Bearer ${f.cashierToken}`).send({ pin: "1234" }).expect(403);
    await http().put(`${base}/${f.cashier.id}/pin`).set("authorization", `Bearer ${f.adminToken}`).send({ pin: "12" }).expect(400);
    await http().put(`${base}/${g.cashier.id}/pin`).set("authorization", `Bearer ${f.adminToken}`).send({ pin: "1234" }).expect(404);
    await http().put(`${base}/${f.cashier.id}/pin`).set("authorization", `Bearer ${f.adminToken}`).send({ pin: "4321" }).expect(200);
    const pin = await testPrisma.edgeStaffPin.findUniqueOrThrow({ where: { userId: f.cashier.id } });
    expect(verifyPin("4321", pin.pinHash)).toBe(true);
    const rows = (await http().get(base).set("authorization", `Bearer ${f.adminToken}`).expect(200)).body as { userId: string; hasPin: boolean }[];
    expect(rows.find((r) => r.userId === f.cashier.id)!.hasPin).toBe(true);
    await http().delete(`${base}/${f.cashier.id}/pin`).set("authorization", `Bearer ${f.adminToken}`).expect(200);
    expect(await testPrisma.edgeStaffPin.count()).toBe(0);
  });
});
