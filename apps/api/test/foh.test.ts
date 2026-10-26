import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthUser } from "@stello/shared";
import { PrismaService } from "../src/prisma/prisma.service";
import { OrdersService } from "../src/orders/orders.service";
import { FohEvents } from "../src/foh/foh-events";
import { ServerCallsService } from "../src/foh/server-calls.service";
import { FloorService } from "../src/foh/floor.service";
import { ReservationsService } from "../src/foh/reservations.service";
import { CfdService } from "../src/foh/cfd.service";
import { MediaService } from "../src/media/media.service";
import { LocalDiskStorage, S3Storage, storageFromEnv } from "../src/media/media.storage";
import { inspectImage, validateImage } from "../src/media/image-inspect";
import { enterTenant } from "../src/common/tenant-context";

const prisma = new PrismaService();
afterAll(() => prisma.$disconnect());

const emitted: { room: string; event: string; payload: any }[] = [];
const realtime = {
  notifyOutlet: vi.fn(),
  server: { to: (room: string) => ({ emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }) }) },
};
const events = new FohEvents(realtime as any);
const calls = new ServerCallsService(prisma, events);
const floor = new FloorService(prisma, events, calls);
const notifier = { send: vi.fn(async () => undefined) };
const reservations = new ReservationsService(prisma, events, notifier);
const orders = new OrdersService(prisma, realtime as any, { verifyAndConsume: vi.fn() } as any);
const cfdGateway = { emitState: vi.fn(), emitUnpaired: vi.fn() };
const cfd = new CfdService(prisma, cfdGateway as any);

async function fixture(name = "FOH") {
  const tenant = await prisma.tenant.create({ data: { name } });
  const role = await prisma.role.create({ data: { tenantId: tenant.id, name: "Owner", permissions: ["*"] } });
  const actor = await prisma.user.create({
    data: { tenantId: tenant.id, roleId: role.id, name: "Owner", email: `${tenant.id}@example.com`, passwordHash: "x" },
  });
  const brand = await prisma.brand.create({ data: { tenantId: tenant.id, name: "Brand" } });
  const outlet = await prisma.outlet.create({ data: { tenantId: tenant.id, brandId: brand.id, name: "Outlet" } });
  await prisma.userOutlet.create({ data: { userId: actor.id, outletId: outlet.id } });
  const category = await prisma.menuCategory.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Menu" } });
  const item = await prisma.item.create({
    data: { tenantId: tenant.id, outletId: outlet.id, categoryId: category.id, name: "Meal", price: 100, taxRate: 5 },
  });
  const area = await prisma.area.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: "Floor" } });
  const t1 = await prisma.diningTable.create({
    data: { tenantId: tenant.id, outletId: outlet.id, areaId: area.id, name: "T1", publicToken: `tok-${tenant.id}-1` },
  });
  const t2 = await prisma.diningTable.create({
    data: { tenantId: tenant.id, outletId: outlet.id, areaId: area.id, name: "T2", publicToken: `tok-${tenant.id}-2` },
  });
  const user: AuthUser = {
    id: actor.id,
    tenantId: tenant.id,
    email: actor.email,
    name: "Owner",
    roleName: "Owner",
    permissions: ["*"],
    outletIds: [outlet.id],
    isPlatformAdmin: false,
  };
  return { tenant, outlet, item, area, t1, t2, user };
}

const at = (h: number, m = 0) => new Date(Date.UTC(2030, 0, 15, h, m)).toISOString();
const booking = (tableIds: string[], startAt: string, durationMinutes = 90) => ({
  guestName: "Guest",
  phone: "9876543210",
  partySize: 2,
  startAt,
  durationMinutes,
  tableIds,
  source: "PHONE" as const,
});

describe("reservations", () => {
  it("rejects overlapping bookings on a table but allows back-to-back and other tables", async () => {
    const f = await fixture();
    await reservations.create(f.user, f.outlet.id, booking([f.t1.id], at(19)));
    await expect(reservations.create(f.user, f.outlet.id, booking([f.t1.id], at(20)))).rejects.toThrow("already reserved");
    await expect(reservations.create(f.user, f.outlet.id, booking([f.t1.id], at(18), 61))).rejects.toThrow("already reserved");
    await reservations.create(f.user, f.outlet.id, booking([f.t1.id], at(20, 30))); // starts exactly when the first ends
    await reservations.create(f.user, f.outlet.id, booking([f.t1.id], at(17, 30))); // ends exactly at 19:00
    await reservations.create(f.user, f.outlet.id, booking([f.t2.id], at(19, 15)));
    // A multi-table booking clashes if any of its tables is held.
    await expect(reservations.create(f.user, f.outlet.id, booking([f.t2.id, f.t1.id], at(22)))).resolves.toBeTruthy();
    await expect(reservations.create(f.user, f.outlet.id, booking([f.t2.id], at(22, 30)))).rejects.toThrow("already reserved");
  });

  it("frees the slot on cancel / no-show and re-checks conflicts when reinstating", async () => {
    const f = await fixture();
    const first = await reservations.create(f.user, f.outlet.id, booking([f.t1.id], at(19)));
    await reservations.setStatus(f.user, f.outlet.id, first.id, "CANCELLED");
    const second = await reservations.create(f.user, f.outlet.id, booking([f.t1.id], at(19, 30)));
    await expect(reservations.setStatus(f.user, f.outlet.id, first.id, "BOOKED")).rejects.toThrow("already reserved");
    await reservations.setStatus(f.user, f.outlet.id, second.id, "NO_SHOW");
    expect((await reservations.setStatus(f.user, f.outlet.id, first.id, "BOOKED")).status).toBe("BOOKED");
  });

  it("accepts exactly one of several concurrent bookings for the same slot", async () => {
    const f = await fixture();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => reservations.create(f.user, f.outlet.id, booking([f.t1.id], at(19)))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.reservation.count()).toBe(1);
  });

  it("enforces the status flow and seats onto a free table", async () => {
    const f = await fixture();
    const r = await reservations.create(f.user, f.outlet.id, booking([f.t1.id], at(19)));
    expect((await reservations.setStatus(f.user, f.outlet.id, r.id, "CONFIRMED")).status).toBe("CONFIRMED");
    await expect(reservations.setStatus(f.user, f.outlet.id, r.id, "SEATED")).rejects.toThrow("Use seat");
    // The table has a running order → cannot seat there.
    await orders.create(f.user, { outletId: f.outlet.id, orderType: "DINE_IN", tableId: f.t1.id, items: [{ itemId: f.item.id, quantity: 1, addonIds: [] }], combos: [] });
    await expect(reservations.seat(f.user, f.outlet.id, r.id)).rejects.toThrow("running order");
    const seated = await reservations.seat(f.user, f.outlet.id, r.id, f.t2.id);
    expect(seated.tableId).toBe(f.t2.id);
    expect(seated.reservation.status).toBe("SEATED");
    expect(seated.reservation.tables.map((t) => t.name).sort()).toEqual(["T1", "T2"]);
    await expect(reservations.setStatus(f.user, f.outlet.id, r.id, "CANCELLED")).rejects.toThrow("Cannot move");
    await expect(reservations.update(f.user, f.outlet.id, r.id, { partySize: 3 })).rejects.toThrow("cannot be edited");
  });

  it("links the CRM customer by phone and edits with a fresh conflict check", async () => {
    const f = await fixture();
    await prisma.customer.create({ data: { tenantId: f.tenant.id, outletId: f.outlet.id, phone: "9876543210", name: "Regular", totalOrders: 7 } });
    const r = await reservations.create(f.user, f.outlet.id, booking([f.t1.id], at(19)));
    expect(r.customer).toMatchObject({ name: "Regular", totalOrders: 7 });
    const other = await reservations.create(f.user, f.outlet.id, { ...booking([f.t2.id], at(19)), phone: "9000000000" });
    expect(other.customer).toBeNull();
    await expect(reservations.update(f.user, f.outlet.id, other.id, { tableIds: [f.t1.id] })).rejects.toThrow("already reserved");
    const moved = await reservations.update(f.user, f.outlet.id, other.id, { startAt: at(21), tableIds: [f.t1.id] });
    expect(moved.tables).toEqual([{ id: f.t1.id, name: "T1" }]);
  });

  it("isolates tenants", async () => {
    const a = await fixture("A");
    const b = await fixture("B");
    await expect(reservations.create(a.user, a.outlet.id, booking([b.t1.id], at(19)))).rejects.toThrow("Table not found");
    const r = await reservations.create(a.user, a.outlet.id, booking([a.t1.id], at(19)));
    await expect(reservations.getOne({ ...b.user, outletIds: [a.outlet.id] }, a.outlet.id, r.id)).rejects.toThrow("not found");
    await expect(reservations.list(b.user, a.outlet.id, new Date(at(0)), new Date(at(23)))).rejects.toThrow("No access");
    await expect(reservations.setStatus({ ...b.user, outletIds: [a.outlet.id] }, a.outlet.id, r.id, "CANCELLED")).rejects.toThrow("not found");
  });
});

describe("waitlist", () => {
  it("adds, notifies through the provider and seats a party once", async () => {
    const f = await fixture();
    const w = await reservations.addToWaitlist(f.user, f.outlet.id, { guestName: "Walk-in", phone: "9811111111", partySize: 3, quotedMinutes: 20 });
    expect(w.status).toBe("WAITING");
    const n = await reservations.notify(f.user, f.outlet.id, w.id);
    expect(n.status).toBe("NOTIFIED");
    expect(notifier.send).toHaveBeenCalledWith("SMS", "9811111111", expect.stringContaining("ready"));
    const seated = await reservations.seatFromWaitlist(f.user, f.outlet.id, w.id, f.t1.id);
    expect(seated.entry.status).toBe("SEATED");
    await expect(reservations.seatFromWaitlist(f.user, f.outlet.id, w.id, f.t2.id)).rejects.toThrow("no longer waiting");
    await expect(reservations.leaveWaitlist(f.user, f.outlet.id, w.id)).rejects.toThrow("no longer waiting");
  });
});

describe("server calls", () => {
  it("runs the OPEN → ACKNOWLEDGED → RESOLVED lifecycle and de-duplicates repeat taps", async () => {
    const f = await fixture();
    emitted.length = 0;
    const first = await calls.callFromTable(f.t1.publicToken!, "WATER");
    const again = await calls.callFromTable(f.t1.publicToken!, "WATER");
    expect(again.callId).toBe(first.callId);
    const bill = await calls.callFromTable(f.t1.publicToken!, "BILL");
    expect(bill.callId).not.toBe(first.callId);
    expect(emitted.filter((e) => e.event === "foh:call")).toHaveLength(2);
    expect(emitted[0].room).toBe(`outlet:${f.outlet.id}`);

    enterTenant(f.tenant.id);
    expect((await calls.list(f.user, f.outlet.id)).map((c) => c.type).sort()).toEqual(["BILL", "WATER"]);
    const acked = await calls.acknowledge(f.user, f.outlet.id, first.callId);
    expect(acked).toMatchObject({ status: "ACKNOWLEDGED", acknowledgedBy: "Owner", tableName: "T1" });
    await expect(calls.acknowledge(f.user, f.outlet.id, first.callId)).rejects.toThrow("already acknowledged");
    expect((await calls.resolve(f.user, f.outlet.id, first.callId)).status).toBe("RESOLVED");
    await expect(calls.resolve(f.user, f.outlet.id, first.callId)).rejects.toThrow("already resolved");
    // A resolved call no longer suppresses a new one.
    const fresh = await calls.callFromTable(f.t1.publicToken!, "WATER");
    expect(fresh.callId).not.toBe(first.callId);
    expect(await prisma.auditLog.count({ where: { action: "SERVER_CALL_WATER" } })).toBe(2);
  });

  it("lets exactly one of several concurrent acknowledgements win", async () => {
    const f = await fixture();
    const { callId } = await calls.callFromTable(f.t1.publicToken!, "WAITER");
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => calls.acknowledge(f.user, f.outlet.id, callId)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("collapses concurrent diner taps into one call", async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 5 }, () => calls.callFromTable(f.t1.publicToken!, "WAITER")));
    expect(await prisma.serverCall.count()).toBe(1);
  });

  it("isolates tenants and rejects unknown tables", async () => {
    const a = await fixture("A");
    const b = await fixture("B");
    const { callId } = await calls.callFromTable(a.t1.publicToken!, "WAITER");
    const intruder = { ...b.user, outletIds: [a.outlet.id] };
    enterTenant(b.tenant.id);
    await expect(calls.acknowledge(intruder, a.outlet.id, callId)).rejects.toThrow("not found");
    expect(await calls.list(intruder, a.outlet.id)).toEqual([]);
    await expect(calls.callByStaff(b.user, b.outlet.id, a.t1.id, "BILL")).rejects.toThrow("Table not found");
    await expect(calls.callFromTable("nope", "WAITER")).rejects.toThrow("no longer active");
  });
});

describe("floor plan + live floor", () => {
  const plan = (tables: any[]) => ({ width: 800, height: 600, tables });
  const place = (over: Record<string, unknown>) => ({ name: "T", seats: 4, shape: "SQUARE", x: 0, y: 0, width: 90, height: 90, rotation: 0, ...over });

  it("saves placements, creates new tables and reports live status", async () => {
    const f = await fixture();
    const view = await floor.savePlan(f.user, f.outlet.id, f.area.id, plan([
      place({ tableId: f.t1.id, name: "T1", x: 10, y: 10, seats: 6, shape: "RECT", width: 150 }),
      place({ tableId: f.t2.id, name: "T2", x: 200, y: 10, rotation: 45 }),
      place({ name: "T3", x: 400, y: 10, shape: "ROUND" }),
    ]));
    const area = view.areas[0];
    expect(area.width).toBe(800);
    expect(area.tables).toHaveLength(3);
    const t3 = await prisma.diningTable.findFirstOrThrow({ where: { name: "T3" } });
    expect(t3.publicToken).toBeTruthy();
    expect((await prisma.diningTable.findUniqueOrThrow({ where: { id: f.t1.id } })).seats).toBe(6);

    // Occupied → bill printed; reserved for an upcoming booking.
    const order = await orders.create(f.user, { outletId: f.outlet.id, orderType: "DINE_IN", tableId: f.t1.id, items: [{ itemId: f.item.id, quantity: 2, addonIds: [] }], combos: [] });
    await reservations.create(f.user, f.outlet.id, booking([f.t2.id], new Date(Date.now() + 30 * 60_000).toISOString()));
    let live = await floor.view(f.user, f.outlet.id);
    const byName = (n: string) => live.areas[0].tables.find((t) => t.name === n)!;
    expect(byName("T1")).toMatchObject({ status: "OCCUPIED", orderId: order.id, orderTotal: 210 });
    expect(byName("T1").placement).toMatchObject({ shape: "RECT", width: 150 });
    expect(byName("T2").status).toBe("RESERVED");
    expect(byName("T3").status).toBe("FREE");
    const res = await floor.requestBill(f.user, f.outlet.id, f.t1.id);
    expect(res.call.type).toBe("BILL");
    live = await floor.view(f.user, f.outlet.id);
    expect(byName("T1")).toMatchObject({ status: "BILL_PRINTED", openCalls: ["BILL"] });
    await expect(floor.requestBill(f.user, f.outlet.id, f.t2.id)).rejects.toThrow("no running order");
  });

  it("removing a table from the plan keeps the table but unplaces it", async () => {
    const f = await fixture();
    await floor.savePlan(f.user, f.outlet.id, f.area.id, plan([place({ tableId: f.t1.id, name: "T1" }), place({ tableId: f.t2.id, name: "T2", x: 100 })]));
    const view = await floor.savePlan(f.user, f.outlet.id, f.area.id, plan([place({ tableId: f.t1.id, name: "T1" })]));
    expect(view.areas[0].tables.find((t) => t.name === "T2")?.placement).toBeNull();
    // ...and its name stays reserved within the area.
    await expect(floor.savePlan(f.user, f.outlet.id, f.area.id, plan([place({ name: "t2" })]))).rejects.toThrow("already used");
  });

  it("rejects tables from other areas or tenants", async () => {
    const a = await fixture("A");
    const b = await fixture("B");
    const patio = await prisma.area.create({ data: { tenantId: a.tenant.id, outletId: a.outlet.id, name: "Patio" } });
    await expect(floor.savePlan(a.user, a.outlet.id, patio.id, plan([place({ tableId: a.t1.id, name: "T1" })]))).rejects.toThrow("not in this area");
    await expect(floor.savePlan(a.user, a.outlet.id, a.area.id, plan([place({ tableId: b.t1.id, name: "T1" })]))).rejects.toThrow("not in this area");
    await expect(floor.savePlan(a.user, a.outlet.id, b.area.id, plan([]))).rejects.toThrow("Area not found");
    await expect(floor.view(a.user, b.outlet.id)).rejects.toThrow("No access");
  });

  it("assigns waiter sections and surfaces them on calls", async () => {
    const f = await fixture();
    const role = await prisma.role.create({ data: { tenantId: f.tenant.id, name: "Waiter", permissions: ["orders.create", "captain.operate"] } });
    const w = await prisma.user.create({ data: { tenantId: f.tenant.id, roleId: role.id, name: "Wanda", email: `w-${f.tenant.id}@x.com`, passwordHash: "x" } });
    await prisma.userOutlet.create({ data: { userId: w.id, outletId: f.outlet.id } });
    const sections = await floor.assignWaiter(f.user, f.outlet.id, { userId: w.id, areaIds: [f.area.id], tableIds: [] });
    expect(sections.find((s) => s.userId === w.id)?.areaIds).toEqual([f.area.id]);
    const call = await calls.callByStaff(f.user, f.outlet.id, f.t1.id, "WATER");
    expect(call.assignedUserIds).toEqual([w.id]);
    const other = await fixture("Other");
    await expect(floor.assignWaiter(f.user, f.outlet.id, { userId: w.id, areaIds: [other.area.id], tableIds: [] })).rejects.toThrow("Unknown area");
  });
});

describe("customer-facing display", () => {
  it("pairs by code, accepts state from its own outlet only", async () => {
    const a = await fixture("A");
    const b = await fixture("B");
    const s = await cfd.start();
    expect(s.pairingCode).toMatch(/^\d{6}$/);
    expect((await cfd.byToken(s.token)).paired).toBe(false);
    enterTenant(a.tenant.id);
    const { id } = await cfd.pair(a.user, a.outlet.id, s.pairingCode);
    await expect(cfd.pair(b.user, b.outlet.id, s.pairingCode)).rejects.toThrow("not valid");
    await cfd.pushState(a.user, a.outlet.id, id, {
      mode: "CART", label: "T1", lines: [{ name: "Meal", quantity: 1, amount: 100 }], subtotal: 100, discount: 0, tax: 5, total: 105, upi: null,
    });
    const view = await cfd.byToken(s.token);
    expect(view).toMatchObject({ paired: true, pairingCode: null, outletName: "Outlet", state: { total: 105 } });
    expect(cfdGateway.emitState).toHaveBeenCalled();
    enterTenant(b.tenant.id);
    await expect(cfd.pushState({ ...b.user, outletIds: [a.outlet.id] }, a.outlet.id, id, view.state!)).rejects.toThrow("not paired");
    await expect(cfd.byToken("bogus")).rejects.toThrow("expired");
  });
});

// ---------- Menu images ----------

function png(width: number, height: number, extra = 0) {
  const b = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function jpeg(width: number, height: number) {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0xff, 0xd9,
  ]);
}

describe("menu image validation + storage", () => {
  it("sniffs real image types and dimensions", () => {
    expect(inspectImage(png(640, 480))).toMatchObject({ type: "image/png", width: 640, height: 480 });
    expect(inspectImage(jpeg(1200, 800))).toMatchObject({ type: "image/jpeg", ext: "jpg", width: 1200, height: 800 });
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBPVP8X", 8, "ascii");
    webp.writeUIntLE(299, 24, 3);
    webp.writeUIntLE(199, 27, 3);
    expect(inspectImage(webp)).toMatchObject({ type: "image/webp", width: 300, height: 200 });
  });

  it("rejects non-images, spoofed files, oversize and huge dimensions", () => {
    expect(() => validateImage(Buffer.from("<svg onload=alert(1)></svg>".padEnd(64)))).toThrow("Only JPEG, PNG or WebP");
    expect(() => validateImage(Buffer.from("GIF89a".padEnd(64)))).toThrow("Only JPEG, PNG or WebP");
    expect(() => validateImage(Buffer.alloc(0))).toThrow("empty");
    expect(() => validateImage(png(100, 100, 3 * 1024 * 1024))).toThrow("larger than");
    expect(() => validateImage(png(5000, 100))).toThrow("at most 4096px");
    expect(validateImage(png(800, 600)).ext).toBe("png");
  });

  it("stores an item photo, replaces the old file and enforces tenancy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stello-media-"));
    try {
      const storage = new LocalDiskStorage(dir);
      const media = new MediaService(prisma, realtime as any, storage);
      const a = await fixture("A");
      const b = await fixture("B");
      const first = await media.setItemImage(a.user, a.outlet.id, a.item.id, { buffer: png(400, 300) });
      expect(first.imageUrl).toMatch(new RegExp(`^/api/v1/media/items/${a.tenant.id}/${a.item.id}-[0-9a-f]{12}\\.png$`));
      const key = storage.keyFromUrl(first.imageUrl)!;
      expect(await media.read(key)).toEqual(png(400, 300));
      const second = await media.setItemImage(a.user, a.outlet.id, a.item.id, { buffer: jpeg(10, 10) });
      expect(second.imageUrl.endsWith(".jpg")).toBe(true);
      expect(await readdir(join(dir, "items", a.tenant.id))).toHaveLength(1); // old photo removed
      expect((await prisma.item.findUniqueOrThrow({ where: { id: a.item.id } })).imageUrl).toBe(second.imageUrl);

      await expect(media.setItemImage(a.user, a.outlet.id, a.item.id, { buffer: Buffer.from("not an image at all, sorry!!") })).rejects.toThrow("Only JPEG");
      await expect(media.setItemImage(a.user, a.outlet.id, a.item.id, undefined)).rejects.toThrow("Attach an image");
      await expect(media.setItemImage({ ...b.user, outletIds: [a.outlet.id] }, a.outlet.id, a.item.id, { buffer: png(1, 1) })).rejects.toThrow("Item not found");
      await expect(media.setItemImage(b.user, a.outlet.id, a.item.id, { buffer: png(1, 1) })).rejects.toThrow("No access");
      await media.clearItemImage(a.user, a.outlet.id, a.item.id);
      expect(await readdir(join(dir, "items", a.tenant.id))).toHaveLength(0);
      await expect(storage.read("../../etc/passwd")).resolves.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("signs S3 uploads and selects the adapter from env", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const s3 = new S3Storage(
      { endpoint: "https://s3.example.com", region: "ap-south-1", bucket: "menu", accessKeyId: "AKID", secretAccessKey: "secret", publicBaseUrl: "https://cdn.example.com" },
      fetchImpl as any,
    );
    const { url } = await s3.put("items/t1/i1-abc.png", png(1, 1), "image/png");
    expect(url).toBe("https://cdn.example.com/items/t1/i1-abc.png");
    const [target, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe("https://s3.example.com/menu/items/t1/i1-abc.png");
    expect((init.headers as Record<string, string>).authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/ap-south-1\/s3\/aws4_request, SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(s3.keyFromUrl(url)).toBe("items/t1/i1-abc.png");
    expect(s3.keyFromUrl("https://elsewhere.com/items/t1/i1-abc.png")).toBeNull();
    expect(storageFromEnv({ S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" }).name).toBe("s3");
    expect(storageFromEnv({}).name).toBe("local");
  });
});
