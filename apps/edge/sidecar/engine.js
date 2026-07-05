"use strict";
// Offline-first local master engine. Owns a better-sqlite3 database that is the
// device's source of truth. Orders are created/settled locally (optimistic writes)
// and pushed to the cloud when connectivity returns. Plain CommonJS so it runs
// unchanged under a Node sidecar and the Electron main process.

const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const Database = require("better-sqlite3");
// Shared integer-paise money formula — the exact same code the cloud API runs, so
// an order billed offline totals identically to one billed online.
const { computeOrderTotals, lineTotalPaise, fromPaise, toPaise } = require("@petpooja/shared");

class EdgeEngine {
  constructor({ dataDir, apiUrl }) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "edge.db"));
    this.db.pragma("journal_mode = WAL");
    this.apiUrl = apiUrl;
    this.forcedOffline = false; // test hook to simulate WAN down
    this._migrate();
    if (!this._meta("deviceId")) this._setMeta("deviceId", "DEV-" + randomUUID().slice(0, 8).toUpperCase());
    if (!this._meta("billSeq")) this._setMeta("billSeq", "0");
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS ref_cache (kind TEXT PRIMARY KEY, json TEXT);
      CREATE TABLE IF NOT EXISTS orders (
        clientId        TEXT PRIMARY KEY,
        state           TEXT NOT NULL,       -- full JSON order snapshot
        status          TEXT NOT NULL,       -- OPEN | SETTLED | CANCELLED
        dirty           INTEGER NOT NULL,    -- 1 = needs push
        clientUpdatedAt TEXT NOT NULL,
        serverId        TEXT,
        billNumber      TEXT
      );
    `);
  }

  _meta(k) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(k);
    return row ? row.value : null;
  }
  _setMeta(k, v) {
    this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v));
  }

  get deviceId() {
    return this._meta("deviceId");
  }

  // ---------- auth + reference cache ----------

  setSession({ token, outletId, outletName }) {
    this._setMeta("token", token);
    this._setMeta("outletId", outletId);
    if (outletName) this._setMeta("outletName", outletName);
  }
  get outletId() {
    return this._meta("outletId");
  }
  cacheSnapshot(snapshot) {
    this.db.prepare("INSERT INTO ref_cache(kind,json) VALUES('menu',?) ON CONFLICT(kind) DO UPDATE SET json=excluded.json").run(JSON.stringify(snapshot.menu));
    this.db.prepare("INSERT INTO ref_cache(kind,json) VALUES('areas',?) ON CONFLICT(kind) DO UPDATE SET json=excluded.json").run(JSON.stringify(snapshot.areas));
    this._setMeta("snapshotAt", new Date().toISOString());
  }
  menu() {
    const row = this.db.prepare("SELECT json FROM ref_cache WHERE kind='menu'").get();
    return row ? JSON.parse(row.json) : [];
  }
  areas() {
    const row = this.db.prepare("SELECT json FROM ref_cache WHERE kind='areas'").get();
    return row ? JSON.parse(row.json) : [];
  }

  // ---------- local order operations (optimistic) ----------

  _resolveLine(input) {
    const items = this.menu().flatMap((c) => c.items);
    const item = items.find((i) => i.id === input.itemId);
    if (!item) throw new Error("Unknown item " + input.itemId);
    let unitPrice = item.price;
    let variationName = null;
    if (input.variationId) {
      const v = item.variations.find((x) => x.id === input.variationId);
      if (!v) throw new Error("Bad variation");
      unitPrice = v.price;
      variationName = v.name;
    }
    const allAddons = item.addonGroups.flatMap((g) => g.addons);
    const addonNames = [];
    for (const id of input.addonIds || []) {
      const a = allAddons.find((x) => x.id === id);
      if (!a) throw new Error("Bad addon");
      unitPrice += a.price;
      addonNames.push(a.name);
    }
    return {
      input: { itemId: input.itemId, variationId: input.variationId, addonIds: input.addonIds || [], quantity: input.quantity, note: input.note },
      itemName: item.name,
      variationName,
      addonNames,
      quantity: input.quantity,
      unitPrice,
      lineTotal: fromPaise(lineTotalPaise(unitPrice, input.quantity)),
      taxRate: item.taxRate,
    };
  }

  _totals(lines, discountAmount) {
    // Delegate to the shared paise formula so edge totals match the server exactly.
    return computeOrderTotals(
      lines.map((l) => ({ lineTotalPaise: toPaise(l.lineTotal), taxRatePercent: l.taxRate })),
      discountAmount || 0,
    );
  }

  createOrder({ orderType, tableId, customerName, customerPhone, items }) {
    const lines = items.map((i) => this._resolveLine(i));
    const t = this._totals(lines, 0);
    const clientId = randomUUID();
    const order = {
      clientId,
      orderType,
      tableId: tableId || null,
      customerName: customerName || null,
      customerPhone: customerPhone || null,
      lines,
      payments: [],
      ...t,
      status: "OPEN",
      offlineRef: null,
      clientUpdatedAt: new Date().toISOString(),
    };
    this._save(order, "OPEN", 0); // OPEN orders aren't pushed until terminal
    return order;
  }

  settleOrder(clientId, { payments, discountAmount }) {
    const order = this._get(clientId);
    if (!order) throw new Error("Order not found");
    if (order.status !== "OPEN") throw new Error("Order is not open");
    const t = this._totals(order.lines, discountAmount || 0);
    const paid = (payments || []).reduce((s, p) => s + p.amount, 0);
    if (Math.abs(paid - t.total) > 0.01) throw new Error(`Payments (${paid}) must equal total (${t.total})`);
    const seq = parseInt(this._meta("billSeq"), 10) + 1;
    this._setMeta("billSeq", seq);
    // A provisional reference for the customer's offline receipt — NOT the tax
    // invoice number. The server assigns the authoritative GST bill number from
    // the single outlet series when this order syncs.
    Object.assign(order, t, {
      payments,
      status: "SETTLED",
      offlineRef: `${this.deviceId.split("-")[1] || "D"}-${seq}`,
      clientUpdatedAt: new Date().toISOString(),
    });
    this._save(order, "SETTLED", 1); // dirty → will push on next sync
    return order;
  }

  cancelOrder(clientId) {
    const order = this._get(clientId);
    if (!order) throw new Error("Order not found");
    order.status = "CANCELLED";
    order.clientUpdatedAt = new Date().toISOString();
    this._save(order, "CANCELLED", 1);
    return order;
  }

  _save(order, status, dirty) {
    this.db
      .prepare(
        `INSERT INTO orders(clientId,state,status,dirty,clientUpdatedAt,serverId,billNumber)
         VALUES(@clientId,@state,@status,@dirty,@clientUpdatedAt,@serverId,@billNumber)
         ON CONFLICT(clientId) DO UPDATE SET state=@state,status=@status,dirty=@dirty,clientUpdatedAt=@clientUpdatedAt,serverId=@serverId,billNumber=@billNumber`,
      )
      .run({
        clientId: order.clientId,
        state: JSON.stringify(order),
        status,
        dirty,
        clientUpdatedAt: order.clientUpdatedAt,
        serverId: order._serverId || null,
        // Local `billNumber` holds the authoritative server number once synced;
        // before sync it stays null (the provisional value is `offlineRef`).
        billNumber: order.billNumber || null,
      });
  }
  _get(clientId) {
    const row = this.db.prepare("SELECT state FROM orders WHERE clientId=?").get(clientId);
    return row ? JSON.parse(row.state) : null;
  }

  listOrders() {
    return this.db
      .prepare("SELECT clientId,status,dirty,serverId,billNumber,state FROM orders ORDER BY clientUpdatedAt DESC")
      .all()
      .map((r) => {
        const s = JSON.parse(r.state);
        return {
          clientId: r.clientId,
          status: r.status,
          synced: r.dirty === 0,
          serverId: r.serverId,
          billNumber: r.billNumber, // authoritative GST number (after sync)
          offlineRef: s.offlineRef, // provisional device reference (offline receipt)
          total: s.total,
          orderType: s.orderType,
          tableId: s.tableId,
          lineCount: s.lines.length,
        };
      });
  }
  pendingCount() {
    return this.db.prepare("SELECT COUNT(*) c FROM orders WHERE dirty=1 AND status IN ('SETTLED','CANCELLED')").get().c;
  }

  // ---------- sync ----------

  async _api(pathname, options = {}) {
    if (this.forcedOffline) throw new Error("offline");
    const token = this._meta("token");
    const res = await fetch(`${this.apiUrl}${pathname}`, {
      ...options,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(body?.message || `HTTP ${res.status}`);
    return body;
  }

  /** Log in to the cloud once to seed token + outlet + reference snapshot. */
  async bootstrap({ email, password }) {
    const login = await this._api("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    const outlets = await this._apiAuthed(login.accessToken, "/outlets");
    const outlet = outlets.find((o) => o.name.includes("Koramangala")) || outlets[0];
    this.setSession({ token: login.accessToken, outletId: outlet.id, outletName: outlet.name });
    const snap = await this._api(`/sync/snapshot?outletId=${outlet.id}`);
    this.cacheSnapshot(snap);
    return { outletId: outlet.id, outletName: outlet.name, deviceId: this.deviceId };
  }
  async _apiAuthed(token, pathname) {
    const res = await fetch(`${this.apiUrl}${pathname}`, { headers: { Authorization: `Bearer ${token}` } });
    return res.json();
  }

  /** Push dirty terminal orders + refresh the reference snapshot. */
  async sync() {
    const outletId = this.outletId;
    if (!outletId) throw new Error("Not bootstrapped");
    // Refresh reference data.
    const snap = await this._api(`/sync/snapshot?outletId=${outletId}`);
    this.cacheSnapshot(snap);

    // Push the outbox.
    const dirty = this.db
      .prepare("SELECT clientId,state,status FROM orders WHERE dirty=1 AND status IN ('SETTLED','CANCELLED')")
      .all();
    let pushed = 0;
    if (dirty.length) {
      const orders = dirty.map((r) => {
        const s = JSON.parse(r.state);
        return {
          clientId: s.clientId,
          orderType: s.orderType,
          tableId: s.tableId,
          customerName: s.customerName,
          customerPhone: s.customerPhone,
          items: s.lines.map((l) => l.input),
          payments: s.payments,
          status: s.status,
          offlineRef: s.offlineRef,
          discountAmount: s.discountAmount,
          clientUpdatedAt: s.clientUpdatedAt,
          clientVersion: 1,
        };
      });
      const resp = await this._api("/sync/push", {
        method: "POST",
        body: JSON.stringify({ outletId, deviceId: this.deviceId, orders }),
      });
      for (const r of resp.results) {
        if (r.status === "applied" || r.status === "duplicate") {
          this.db
            .prepare("UPDATE orders SET dirty=0, serverId=?, billNumber=COALESCE(?,billNumber) WHERE clientId=?")
            .run(r.serverId, r.billNumber, r.clientId);
          pushed++;
        }
      }
    }
    this._setMeta("lastSyncAt", new Date().toISOString());
    return { pushed, pending: this.pendingCount() };
  }

  async isOnline() {
    if (this.forcedOffline) return false;
    try {
      await fetch(`${this.apiUrl.replace("/api/v1", "")}/api/v1/auth/login`, { method: "OPTIONS" });
      return true;
    } catch {
      return false;
    }
  }

  status() {
    return {
      deviceId: this.deviceId,
      outletId: this.outletId,
      outletName: this._meta("outletName"),
      pending: this.pendingCount(),
      lastSyncAt: this._meta("lastSyncAt"),
      snapshotAt: this._meta("snapshotAt"),
      forcedOffline: this.forcedOffline,
    };
  }
}

module.exports = { EdgeEngine };
