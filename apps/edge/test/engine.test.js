"use strict";
// Sidecar engine tests (node --test). Drive the real EdgeEngine against a real
// SQLite file and an in-memory fake of the cloud's /edge/device API.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { EdgeEngine, EdgeError } = require("../sidecar/engine");
const { hashPin } = require("../sidecar/pin");

const API = "http://cloud.test/api/v1";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "edge-test-"));

function clock(start = Date.parse("2026-10-26T06:30:00Z")) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  now.set = (ms) => (t = ms);
  return now;
}

// ---- a fake cloud: feed pages + an idempotent ingest keyed like the real one ----
function fakeCloud({ serverSkewMs = 0, now = () => Date.now() } = {}) {
  const cloud = {
    feed: [], // { entity, id, op, seq, data }
    seq: 0,
    orders: new Map(), // clientId -> payload
    kotOps: [],
    pushes: 0,
    down: false,
    nextStatus: null, // force a status for the next ORDER op
    serverSkewMs,
    emit(entity, id, data) {
      cloud.feed.push({ entity, id, op: data ? "upsert" : "delete", seq: ++cloud.seq, data: data || null });
    },
  };
  cloud.fetch = async (url, opts = {}) => {
    if (cloud.down) throw new TypeError("fetch failed");
    const u = new URL(url);
    const auth = (opts.headers || {}).Authorization || "";
    const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    // The cloud reads the same (test) clock as the device, plus any configured skew.
    const serverTime = new Date(now() + cloud.serverSkewMs).toISOString();
    if (!auth.startsWith("Device edk_")) return json(401, { message: "Missing device token" });
    if (u.pathname.endsWith("/edge/device/feed")) {
      const cursor = Number(u.searchParams.get("cursor") || 0);
      const limit = Number(u.searchParams.get("limit") || 500);
      const reset = cursor > cloud.seq;
      const rows = cloud.feed.filter((c) => c.seq > (reset ? 0 : cursor)).slice(0, limit + 1);
      const page = rows.slice(0, limit);
      return json(200, { cursor: String(page.length ? page[page.length - 1].seq : reset ? 0 : cursor), changes: page, hasMore: rows.length > limit, reset, serverTime });
    }
    if (u.pathname.endsWith("/edge/device/push")) {
      cloud.pushes++;
      const body = JSON.parse(opts.body);
      const results = body.ops.map((op) => {
        if (op.kind === "KOT_STATUS") {
          cloud.kotOps.push(op);
          return { key: op.key, status: "applied" };
        }
        if (cloud.nextStatus) {
          const status = cloud.nextStatus;
          cloud.nextStatus = null;
          if (status === "retry") return { key: op.key, status };
          if (status === "conflict") {
            cloud.orders.set(op.order.clientId, op.order);
            return { key: op.key, status, billNumber: op.order.billNo && op.order.billNo.number, conflicts: [{ kind: "COUPON_LIMIT_EXCEEDED", message: "over limit" }] };
          }
          return { key: op.key, status, message: "figures do not add up" };
        }
        if (cloud.orders.has(op.order.clientId)) return { key: op.key, status: "duplicate", serverId: "srv-" + op.order.clientId };
        cloud.orders.set(op.order.clientId, op.order);
        return { key: op.key, status: "applied", serverId: "srv-" + op.order.clientId, billNumber: op.order.billNo ? op.order.billNo.number : "B-1" };
      });
      return json(201, { results, serverTime, clockSkewMs: 0 });
    }
    return json(404, { message: "not found" });
  };
  return cloud;
}

async function seedCatalog(cloud) {
  cloud.emit("settings", "outlet", { outletId: "o1", name: "Test Outlet", gstin: "29ABCDE1234F1Z5", themeId: "counter" });
  cloud.emit("category", "c-main", { id: "c-main", name: "Mains", sortOrder: 1, stationId: "s-hot", stationName: "Hot" });
  cloud.emit("category", "c-bar", { id: "c-bar", name: "Drinks", sortOrder: 2, stationId: "s-bar", stationName: "Bar" });
  cloud.emit("item", "i-roll", {
    id: "i-roll", categoryId: "c-main", name: "Paneer Roll", price: 100, isVeg: true, inStock: true, taxRate: 5, sortOrder: 0,
    variations: [{ id: "v-large", name: "Large", price: 140 }],
    addonGroups: [{ id: "g-x", name: "Extras", minSelect: 0, maxSelect: 2, addons: [{ id: "a-cheese", name: "Cheese", price: 20 }, { id: "a-mayo", name: "Mayo", price: 10.5 }] }],
  });
  cloud.emit("item", "i-fries", { id: "i-fries", categoryId: "c-main", name: "Fries", price: 60, isVeg: true, inStock: true, taxRate: 5, variations: [], addonGroups: [] });
  cloud.emit("item", "i-cola", { id: "i-cola", categoryId: "c-bar", name: "Cola", price: 40, isVeg: true, inStock: true, taxRate: 18, variations: [], addonGroups: [] });
  cloud.emit("combo", "k-meal", {
    id: "k-meal", categoryId: "c-main", name: "Roll Meal", price: 180, isVeg: true, inStock: true, taxRate: 5,
    slots: [{ id: "sl-drink", name: "Drink", options: [{ id: "op1", itemId: "i-cola", name: "Cola", priceDelta: 0, isDefault: true, isVeg: true, inStock: true }, { id: "op2", itemId: "i-fries", name: "Fries", priceDelta: 15, isDefault: false, isVeg: true, inStock: true }] }],
  });
  cloud.emit("area", "ar1", { id: "ar1", name: "Floor" });
  cloud.emit("table", "t1", { id: "t1", areaId: "ar1", name: "T1", seats: 4, cloudOccupiedBy: null });
  cloud.emit("table", "t2", { id: "t2", areaId: "ar1", name: "T2", seats: 2, cloudOccupiedBy: { orderId: "x", deviceId: "other-terminal" } });
  cloud.emit("staff", "u-cash", { id: "u-cash", name: "Ravi", roleName: "Cashier", permissions: ["orders.create", "orders.settle"], isActive: true, pinHash: await hashPin("1111") });
  cloud.emit("staff", "u-cook", { id: "u-cook", name: "Cook", roleName: "Kitchen", permissions: ["kds.operate"], isActive: true, pinHash: null });
  cloud.emit("coupon", "cp1", { id: "cp1", code: "TENOFF", type: "PERCENT", value: 10, minOrder: 100, maxDiscount: null, validFrom: null, validTo: null, usageLimit: 2, usedCount: 1, isActive: true });
}

/** An engine activated against the fake cloud, with the catalog pulled. */
async function activatedEngine(opts = {}) {
  const now = opts.now || clock();
  const cloud = opts.cloud || fakeCloud({ now });
  if (!opts.cloud) await seedCatalog(cloud);
  const dataDir = opts.dataDir || tmp();
  const engine = new EdgeEngine({ dataDir, apiUrl: API, now, fetchImpl: cloud.fetch });
  engine._setMeta("deviceToken", "edk_dev1.secretsecretsecretsecret");
  engine._setMeta("terminalId", "term-1");
  engine._setMeta("seriesCode", "E01");
  engine._setMeta("outletId", "o1");
  await engine.pull();
  return { engine, cloud, now, dataDir };
}

const PAY = (amount, mode = "CASH") => [{ mode, amount }];

// ---------------------------------------------------------------------------

test("schema migrations upgrade a legacy database and carry its outbox forward", () => {
  const dir = tmp();
  const legacy = new Database(path.join(dir, "edge.db"));
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE ref_cache (kind TEXT PRIMARY KEY, json TEXT);
    CREATE TABLE orders (clientId TEXT PRIMARY KEY, state TEXT NOT NULL, status TEXT NOT NULL, dirty INTEGER NOT NULL, clientUpdatedAt TEXT NOT NULL, serverId TEXT, billNumber TEXT);
  `);
  const state = { clientId: "old-1", orderType: "TAKEAWAY", lines: [{ input: { itemId: "i", addonIds: [], quantity: 1 }, unitPrice: 50, lineTotal: 50, taxRate: 5 }], payments: [{ mode: "CASH", amount: 52.5 }], subtotal: 50, taxAmount: 2.5, total: 52.5, discountAmount: 0, status: "SETTLED", offlineRef: "X-1", clientUpdatedAt: "2026-10-01T10:00:00.000Z" };
  legacy.prepare("INSERT INTO orders VALUES(?,?,?,?,?,?,?)").run("old-1", JSON.stringify(state), "SETTLED", 1, state.clientUpdatedAt, null, null);
  legacy.close();

  const engine = new EdgeEngine({ dataDir: dir, apiUrl: API });
  assert.equal(engine.schemaVersion, 2);
  assert.equal(engine.pendingCount(), 1);
  const payload = engine._orderPayload(engine.getOrder("old-1"));
  assert.equal(payload.items[0].itemId, "i");
  assert.equal(payload.billNo, null); // legacy bill → server assigns from the outlet series
  assert.equal(payload.closedAt, state.clientUpdatedAt);
  engine.close();
  // Re-opening is a no-op (idempotent migrations).
  const again = new EdgeEngine({ dataDir: dir, apiUrl: API });
  assert.equal(again.schemaVersion, 2);
  assert.equal(again.pendingCount(), 1);
  again.close();
});

test("offline dine-in lifecycle: table claim, rounds, variants/addons/combos, split payment and series numbering", async () => {
  const { engine } = await activatedEngine();
  const order = engine.createOrder({
    orderType: "DINE_IN",
    tableId: "t1",
    staffId: "u-cash",
    items: [{ itemId: "i-roll", variationId: "v-large", addonIds: ["a-cheese", "a-mayo"], quantity: 2 }],
    combos: [{ comboId: "k-meal", quantity: 1, selections: [{ slotId: "sl-drink", itemId: "i-fries" }] }],
  });
  assert.equal(order.lines[0].unitPrice, 170.5); // 140 + 20 + 10.5
  assert.equal(order.lines[1].unitPrice, 195); // 180 + 15
  assert.equal(engine.areas()[0].tables.find((t) => t.id === "t1").occupiedByOrderId, order.clientId);
  assert.throws(() => engine.createOrder({ orderType: "DINE_IN", tableId: "t1", items: [{ itemId: "i-fries", quantity: 1 }] }), /already has a running order/);
  assert.throws(() => engine.createOrder({ orderType: "DINE_IN", tableId: "t2", items: [{ itemId: "i-fries", quantity: 1 }] }), /another terminal/);
  assert.throws(() => engine.createOrder({ orderType: "DELIVERY", items: [{ itemId: "i-fries", quantity: 1 }] }), /phone number and address/);
  assert.throws(() => engine.createOrder({ items: [{ itemId: "i-roll", addonIds: ["a-cheese", "a-cheese"], quantity: 1 }] }), /Duplicate addons/);

  engine.addItems(order.clientId, { items: [{ itemId: "i-cola", quantity: 2 }], staffId: "u-cash" });
  const tickets = engine.kdsTickets();
  assert.deepEqual(tickets.map((t) => `${t.kotNo}:${t.stationName}`).sort(), ["1:Hot", "2:Bar"]);

  const current = engine.getOrder(order.clientId);
  // 341 + 195 @5% + 80 @18%: subtotal 616, tax 26.8 + 14.4 = 41.2
  assert.equal(current.subtotal, 616);
  assert.equal(current.total, 657.2);

  // A rejected settlement must not consume an invoice number.
  assert.throws(() => engine.settleOrder(order.clientId, { payments: PAY(600) }), /must equal total/);
  assert.equal(engine.db.prepare("SELECT COUNT(*) c FROM bill_series").get().c, 0);

  const settled = engine.settleOrder(order.clientId, {
    payments: [{ mode: "CASH", amount: 300 }, { mode: "UPI", amount: 200, reference: "UTR99" }, { mode: "CARD", amount: 157.2 }],
    staffId: "u-cash",
  });
  assert.equal(settled.billNo.number, "E01/2627/000001");
  assert.equal(settled.offlineRef, "E01/2627/000001");
  assert.equal(engine.areas()[0].tables.find((t) => t.id === "t1").occupiedByOrderId, null); // table freed
  assert.equal(engine.pendingCount(), 1);

  const next = engine.createOrder({ items: [{ itemId: "i-fries", quantity: 1 }] });
  assert.equal(engine.settleOrder(next.clientId, { payments: PAY(63) }).billNo.number, "E01/2627/000002");
  engine.close();
});

test("bill series restarts on 1 April IST and honours the measured clock skew", async () => {
  const now = clock(Date.parse("2027-03-31T18:20:00Z")); // 23:50 IST, 31 March
  const { engine } = await activatedEngine({ now });
  const a = engine.createOrder({ items: [{ itemId: "i-fries", quantity: 1 }] });
  assert.equal(engine.settleOrder(a.clientId, { payments: PAY(63) }).billNo.number, "E01/2627/000001");
  // The device clock is 15 min slow: the cloud says it is already 00:05 IST on 1 April.
  engine._setMeta("clockSkewMs", 15 * 60 * 1000);
  const b = engine.createOrder({ items: [{ itemId: "i-fries", quantity: 1 }] });
  assert.equal(engine.settleOrder(b.clientId, { payments: PAY(63) }).billNo.number, "E01/2728/000001");
  engine.close();
});

test("clock skew is measured from cloud responses", async () => {
  const now = clock();
  const cloud = fakeCloud({ now, serverSkewMs: -120_000 }); // device clock runs 2 min fast
  await seedCatalog(cloud);
  const { engine } = await activatedEngine({ now, cloud });
  assert.equal(engine.status().clockSkewMs, -120_000);
  engine.close();
});

test("coupons: evaluated offline, usage limits counted against unsynced local redemptions", async () => {
  const { engine } = await activatedEngine();
  const o = engine.createOrder({ items: [{ itemId: "i-roll", quantity: 2 }] });
  const p = engine.previewCoupon("tenoff", 200);
  assert.equal(p.valid, true);
  assert.equal(p.limited, true);
  const s = engine.settleOrder(o.clientId, { couponCode: "TENOFF", payments: PAY(189) }); // 200-20=180 +5% = 189
  assert.equal(s.couponDiscount, 20);
  // usedCount 1 + 1 local unsynced use = limit 2 → exhausted on this device.
  const o2 = engine.createOrder({ items: [{ itemId: "i-roll", quantity: 2 }] });
  assert.throws(() => engine.settleOrder(o2.clientId, { couponCode: "TENOFF", payments: PAY(189) }), /usage limit/);
  engine.close();
});

test("outbox: idempotent push, survives transport failure and process restart, backs off on retry", async () => {
  const { engine, cloud, now, dataDir } = await activatedEngine();
  const o = engine.createOrder({ items: [{ itemId: "i-fries", quantity: 2 }], staffId: "u-cash" });
  engine.settleOrder(o.clientId, { payments: PAY(126), staffId: "u-cash" });

  cloud.down = true;
  await assert.rejects(engine.syncOnce(), /fetch failed/);
  assert.equal(engine.pendingCount(), 1);
  assert.match(engine.status().lastError, /fetch failed/);
  engine.close();

  // "Crash": a brand-new engine on the same file still has the queued sale.
  const revived = new EdgeEngine({ dataDir, apiUrl: API, now, fetchImpl: cloud.fetch });
  assert.equal(revived.pendingCount(), 1);
  cloud.down = false;
  cloud.nextStatus = "retry";
  await revived.syncOnce();
  assert.equal(revived.pendingCount(), 1, "a retry keeps the entry pending");
  const entry = revived.db.prepare("SELECT * FROM outbox").get();
  assert.equal(entry.attempts, 1);
  assert.ok(Date.parse(entry.nextAttemptAt) > now(), "and schedules it in the future");
  const pushesBefore = cloud.pushes;
  await revived.syncOnce();
  assert.equal(cloud.pushes, pushesBefore, "not re-sent before its backoff elapses");

  now.advance(60_000);
  const r = await revived.syncOnce();
  assert.equal(r.pushed, 1);
  assert.equal(revived.pendingCount(), 0);
  const row = revived.listOrders()[0];
  assert.equal(row.syncState, "synced");
  assert.equal(row.billNumber, "E01/2627/000001");
  const sent = cloud.orders.get(o.clientId);
  assert.equal(sent.createdByStaffId, "u-cash");
  assert.equal(sent.closedByStaffId, "u-cash");
  assert.equal(sent.total, 126);

  // Re-queueing the same key is a no-op (INSERT OR IGNORE on the idempotency key)…
  revived._enqueue("ORDER", o.clientId, o.clientId, null);
  assert.equal(revived.db.prepare("SELECT COUNT(*) c FROM outbox").get().c, 1);
  // …and a lost acknowledgement resolves as a duplicate, not a second sale.
  revived.db.prepare("UPDATE outbox SET status='pending', nextAttemptAt=?").run(new Date(0).toISOString());
  await revived.syncOnce();
  assert.equal(cloud.orders.size, 1);
  assert.equal(revived.pendingCount(), 0);
  revived.close();
});

test("outbox: server conflicts and rejections are surfaced, not retried", async () => {
  const { engine, cloud } = await activatedEngine();
  const a = engine.createOrder({ items: [{ itemId: "i-fries", quantity: 1 }] });
  engine.settleOrder(a.clientId, { payments: PAY(63) });
  cloud.nextStatus = "conflict";
  await engine.syncOnce();
  const b = engine.createOrder({ items: [{ itemId: "i-fries", quantity: 1 }] });
  engine.settleOrder(b.clientId, { payments: PAY(63) });
  cloud.nextStatus = "rejected";
  await engine.syncOnce();
  assert.equal(engine.pendingCount(), 0);
  const kinds = engine.conflicts().map((c) => c.kind).sort();
  assert.deepEqual(kinds, ["COUPON_LIMIT_EXCEEDED", "REJECTED"]);
  assert.equal(engine.status().conflicts, 2);
  engine.acknowledgeConflict(engine.conflicts()[0].id, "u-cash");
  assert.equal(engine.status().conflicts, 1);
  assert.equal(engine.listOrders().find((o) => o.clientId === b.clientId).syncState, "rejected");
  engine.close();
});

test("pull: incremental feed updates prices/86/staff, applies tombstones, pages, and is atomic", async () => {
  const { engine, cloud } = await activatedEngine();
  const cursor = engine.status().feedCursor;
  cloud.emit("item", "i-fries", { id: "i-fries", categoryId: "c-main", name: "Fries", price: 70, isVeg: true, inStock: false, taxRate: 5, variations: [], addonGroups: [] });
  cloud.emit("item", "i-cola", null); // removed from the menu
  await engine.pull();
  assert.ok(Number(engine.status().feedCursor) > Number(cursor));
  const items = engine.menu().flatMap((c) => c.items);
  assert.equal(items.find((i) => i.id === "i-fries").price, 70);
  assert.equal(items.find((i) => i.id === "i-cola"), undefined);
  assert.throws(() => engine.createOrder({ items: [{ itemId: "i-fries", quantity: 1 }] }), /out of stock/);

  // Paging: 1200 changes arrive over 3 pages.
  for (let i = 0; i < 1200; i++) cloud.emit("area", `bulk-${i}`, { id: `bulk-${i}`, name: `Bulk ${i}` });
  const n = await engine.pull();
  assert.equal(n, 1200);
  assert.equal(engine.status().feedCursor, String(cloud.seq));

  // Atomicity: a page with a bad row applies nothing and leaves the cursor alone.
  const before = engine.status().feedCursor;
  assert.throws(() =>
    engine.applyFeed({ cursor: "999999", reset: false, changes: [{ entity: "area", id: "ok", op: "upsert", seq: 1, data: { id: "ok", name: "x" } }, { entity: null, id: "bad", op: "upsert", seq: 2, data: {} }] }),
  );
  assert.equal(engine.status().feedCursor, before);
  assert.equal(engine.areas().find((a) => a.id === "ok"), undefined);

  // Reset: the cloud's feed was rebuilt → the device drops and re-applies.
  engine._setMeta("feedCursor", String(cloud.seq + 50));
  await engine.pull();
  assert.ok(engine.menu().length > 0);
  engine.close();
});

test("staff PIN login works offline with durable lockout and dies with deactivation", async () => {
  const { engine, cloud, now, dataDir } = await activatedEngine();
  cloud.down = true; // fully offline from here
  assert.deepEqual(engine.staffList().map((s) => [s.name, s.hasPin]), [["Cook", false], ["Ravi", true]]);
  await assert.rejects(engine.pinLogin("u-cook", "0000"), /No PIN set/);
  for (let i = 0; i < 4; i++) await assert.rejects(engine.pinLogin("u-cash", "9999"), /Wrong PIN/);
  await assert.rejects(engine.pinLogin("u-cash", "9999"), (e) => e instanceof EdgeError && e.status === 423);
  await assert.rejects(engine.pinLogin("u-cash", "1111"), /Locked/); // even the right PIN, while locked

  // Lockout survives a restart.
  engine.close();
  const e2 = new EdgeEngine({ dataDir, apiUrl: API, now, fetchImpl: cloud.fetch });
  await assert.rejects(e2.pinLogin("u-cash", "1111"), /Locked/);
  now.advance(5 * 60 * 1000 + 1);
  const { token, staff } = await e2.pinLogin("u-cash", "1111");
  assert.equal(staff.name, "Ravi");
  assert.equal(EdgeEngine.can(e2.resolveSession(token), "orders.settle"), true);
  assert.equal(EdgeEngine.can(e2.resolveSession(token), "kds.operate"), false);

  // Deactivation arriving via the feed ends the session.
  cloud.down = false;
  cloud.emit("staff", "u-cash", { id: "u-cash", name: "Ravi", roleName: "Cashier", permissions: [], isActive: false, pinHash: null });
  await e2.pull();
  assert.equal(e2.resolveSession(token), null);
  now.advance(13 * 60 * 60 * 1000);
  e2.close();
});

test("LAN KDS: pairing, bumping, and kitchen status reconciled to the cloud after sync", async () => {
  const { engine, cloud } = await activatedEngine();
  assert.throws(() => engine.pairScreen({ code: "000000", name: "Line" }), /Invalid/);
  const { code } = engine.createPairingCode();
  const { token } = engine.pairScreen({ code, name: "Hot line" });
  assert.throws(() => engine.pairScreen({ code, name: "again" }), /Invalid/); // single use
  assert.equal(engine.verifyScreen(token).name, "Hot line");

  const o = engine.createOrder({ items: [{ itemId: "i-roll", quantity: 1 }, { itemId: "i-cola", quantity: 1 }] });
  const hot = engine.kdsTickets().find((t) => t.stationName === "Hot");
  engine.advanceTicket(hot.id, "READY");
  engine.settleOrder(o.clientId, { payments: PAY(152.2) }); // 100*1.05 + 40*1.18
  await engine.syncOnce();
  const pushed = cloud.orders.get(o.clientId);
  assert.deepEqual(pushed.items.map((l) => l.prepStatus), ["READY", "PENDING"]); // statuses ride along with the order

  const bar = engine.kdsTickets().find((t) => t.stationName === "Bar");
  engine.advanceTicket(bar.id, "READY");
  assert.equal(engine.pendingCount(), 1); // a KOT_STATUS op for the already-synced order
  await engine.syncOnce();
  assert.deepEqual(cloud.kotOps[0].lines.map((l) => `${l.kind}${l.lineIndex}:${l.prepStatus}`), ["item0:READY", "item1:READY"]);

  // Brute-force guard: 5 wrong codes burn a live code.
  const fresh = engine.createPairingCode();
  for (let i = 0; i < 5; i++) assert.throws(() => engine.pairScreen({ code: fresh.code === "123456" ? "654321" : "123456" }));
  assert.throws(() => engine.pairScreen({ code: fresh.code }), /Invalid/);

  engine.revokeScreen(engine.verifyScreen(token).id);
  assert.equal(engine.verifyScreen(token), null);
  engine.close();
});

test("cancelled orders leave the kitchen and still sync; retention purges only what the cloud has", async () => {
  const { engine, now } = await activatedEngine();
  const keep = engine.createOrder({ items: [{ itemId: "i-fries", quantity: 1 }] });
  engine.settleOrder(keep.clientId, { payments: PAY(63) }); // never synced
  const gone = engine.createOrder({ items: [{ itemId: "i-fries", quantity: 1 }] });
  engine.cancelOrder(gone.clientId, { reason: "walked out" });
  assert.equal(engine.kdsTickets().length, 1);
  const open = engine.createOrder({ items: [{ itemId: "i-fries", quantity: 1 }] });
  await engine.syncOnce(); // pushes keep + gone
  const unsynced = engine.createOrder({ items: [{ itemId: "i-cola", quantity: 1 }] });
  engine.settleOrder(unsynced.clientId, { payments: PAY(47.2) });

  now.advance(40 * 86400000);
  const res = engine.purge();
  assert.equal(res.orders, 2);
  const left = engine.listOrders().map((o) => o.clientId).sort();
  assert.deepEqual(left, [open.clientId, unsynced.clientId].sort());
  assert.equal(engine.pendingCount(), 1);
  engine.close();
});

test("legacy snapshot path still bills (money parity with the shared formula)", () => {
  const engine = new EdgeEngine({ dataDir: tmp(), apiUrl: API });
  engine.cacheSnapshot({
    menu: [{ id: "c", name: "C", sortOrder: 0, combos: [], items: [{ id: "i", name: "Tea", shortCode: null, price: 19.99, isVeg: true, inStock: true, taxRate: 5, variations: [], addonGroups: [] }] }],
    areas: [],
    themeId: "noir",
  });
  assert.equal(engine.status().themeId, "noir");
  const o = engine.createOrder({ orderType: "TAKEAWAY", items: [{ itemId: "i", quantity: 3 }] });
  const t = engine._totals(o.lines, 7.5);
  const s = engine.settleOrder(o.clientId, { payments: PAY(t.total), discountAmount: 7.5 });
  assert.equal(s.total, t.total);
  assert.match(s.offlineRef, /-1$/); // provisional ref: no series before activation
  engine.close();
});
