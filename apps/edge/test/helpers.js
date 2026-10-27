"use strict";
// Shared fixtures for the sidecar tests: a controllable clock and an in-memory
// fake of the cloud's /edge/device API (feed pages + idempotent ingest).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EdgeEngine } = require("../sidecar/engine");
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

module.exports = { API, tmp, clock, fakeCloud, seedCatalog, activatedEngine, PAY };
