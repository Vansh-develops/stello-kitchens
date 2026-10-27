"use strict";
// Offline-first local master engine. Owns a better-sqlite3 database that is the
// device's source of truth. Orders are created/settled locally and pushed to the
// cloud through a durable outbox; the outlet's catalog (menu, prices, 86 status,
// tables, staff + PIN hashes, coupons, outlet/tax settings) is pulled from the
// cloud's per-outlet change feed. The engine also feeds the LAN kitchen display.
// Plain CommonJS so it runs unchanged under the Node sidecar and in tests.

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const Database = require("better-sqlite3");
// Shared integer-paise money formula + bill numbering — the exact code the cloud
// API runs, so an order billed offline totals identically to one billed online.
const {
  computeOrderTotals,
  lineTotalPaise,
  fromPaise,
  toPaise,
  evaluateCoupon,
  fiscalYearCode,
  formatEdgeBillNumber,
} = require("@stello/shared");
const { verifyPin, sha256 } = require("./pin");

const PAYMENT_MODES = new Set(["CASH", "CARD", "UPI", "WALLET", "OTHER"]);
const ORDER_TYPES = new Set(["DINE_IN", "TAKEAWAY", "DELIVERY"]);
const PIN_MAX_FAILURES = 5;
const PIN_LOCK_BASE_MS = 5 * 60 * 1000;
const PIN_LOCK_MAX_MS = 60 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const PUSH_BATCH = 50;
const READY_WINDOW_MS = 10 * 60 * 1000;

class EdgeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Ordered SQLite schema migrations, tracked in PRAGMA user_version. Each runs in
 * its own transaction; never edit a shipped migration — append a new one.
 */
const MIGRATIONS = [
  // 1: the original schema (devices installed before versioned migrations already have it).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS ref_cache (kind TEXT PRIMARY KEY, json TEXT);
      CREATE TABLE IF NOT EXISTS orders (
        clientId        TEXT PRIMARY KEY,
        state           TEXT NOT NULL,
        status          TEXT NOT NULL,
        dirty           INTEGER NOT NULL,
        clientUpdatedAt TEXT NOT NULL,
        serverId        TEXT,
        billNumber      TEXT
      );
    `);
  },
  // 2: change-feed catalog, durable outbox, LAN KDS, staff auth, invoice series.
  (db) => {
    const cols = new Set(db.prepare("PRAGMA table_info(orders)").all().map((c) => c.name));
    const add = (name, ddl) => {
      if (!cols.has(name)) db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${ddl}`);
    };
    add("createdAt", "TEXT");
    add("closedAt", "TEXT");
    add("tableId", "TEXT");
    add("syncState", "TEXT NOT NULL DEFAULT 'local'"); // local | queued | synced | conflict | rejected
    db.exec(`
      CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS orders_table ON orders(tableId, status);
      CREATE TABLE IF NOT EXISTS catalog (
        entity TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, seq INTEGER NOT NULL,
        PRIMARY KEY (entity, id)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        key           TEXT NOT NULL UNIQUE,       -- idempotency key sent to the cloud
        kind          TEXT NOT NULL,              -- ORDER | KOT_STATUS
        clientId      TEXT NOT NULL,
        payload       TEXT,                       -- KOT_STATUS body; ORDER is built from the order row at push time
        status        TEXT NOT NULL DEFAULT 'pending', -- pending | done | conflict | rejected
        attempts      INTEGER NOT NULL DEFAULT 0,
        nextAttemptAt TEXT NOT NULL,
        lastError     TEXT,
        result        TEXT,
        createdAt     TEXT NOT NULL,
        doneAt        TEXT
      );
      CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status, nextAttemptAt);
      CREATE TABLE IF NOT EXISTS conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        clientId TEXT NOT NULL, billNumber TEXT, kind TEXT NOT NULL, message TEXT NOT NULL,
        createdAt TEXT NOT NULL, acknowledgedAt TEXT, acknowledgedBy TEXT
      );
      CREATE TABLE IF NOT EXISTS bill_series (
        series TEXT NOT NULL, fy TEXT NOT NULL, lastSeq INTEGER NOT NULL, PRIMARY KEY (series, fy)
      );
      CREATE TABLE IF NOT EXISTS kots (
        id TEXT PRIMARY KEY, clientId TEXT NOT NULL, kotNo INTEGER NOT NULL,
        stationId TEXT, stationName TEXT NOT NULL, status TEXT NOT NULL,
        items TEXT NOT NULL, label TEXT NOT NULL, orderType TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, readyAt TEXT
      );
      CREATE INDEX IF NOT EXISTS kots_status ON kots(status, updatedAt);
      CREATE TABLE IF NOT EXISTS staff_sessions (
        tokenHash TEXT PRIMARY KEY, staffId TEXT NOT NULL, createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pin_attempts (
        staffId TEXT PRIMARY KEY, failures INTEGER NOT NULL, lockCount INTEGER NOT NULL, lockedUntil TEXT
      );
      CREATE TABLE IF NOT EXISTS kds_screens (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, tokenHash TEXT NOT NULL UNIQUE,
        createdAt TEXT NOT NULL, lastSeenAt TEXT, revokedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS kds_pairing (
        codeHash TEXT PRIMARY KEY, expiresAt TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0
      );
    `);
    // Carry legacy order rows and the legacy outbox (dirty terminal orders) forward.
    const now = new Date().toISOString();
    for (const row of db.prepare("SELECT clientId, state, status FROM orders").all()) {
      const s = JSON.parse(row.state);
      db.prepare("UPDATE orders SET createdAt=?, closedAt=?, tableId=? WHERE clientId=?").run(
        s.createdAt || s.clientUpdatedAt,
        s.closedAt || (row.status !== "OPEN" ? s.clientUpdatedAt : null),
        s.tableId || null,
        row.clientId,
      );
    }
    const dirty = db.prepare("SELECT clientId FROM orders WHERE dirty=1 AND status IN ('SETTLED','CANCELLED')").all();
    for (const r of dirty) {
      db.prepare("INSERT OR IGNORE INTO outbox(key,kind,clientId,nextAttemptAt,createdAt) VALUES(?,?,?,?,?)").run(r.clientId, "ORDER", r.clientId, now, now);
      db.prepare("UPDATE orders SET syncState='queued' WHERE clientId=?").run(r.clientId);
    }
    db.exec("UPDATE orders SET syncState='synced' WHERE dirty=0 AND serverId IS NOT NULL");
  },
];

class EdgeEngine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir   where edge.db lives
   * @param {string} opts.apiUrl    cloud API base, e.g. http://host/api/v1
   * @param {string} [opts.deviceId] provisioned EDGE_DEVICE_ID (terminal id or deviceToken)
   * @param {() => number} [opts.now] clock (tests)
   * @param {typeof fetch} [opts.fetchImpl] HTTP client (tests)
   */
  constructor({ dataDir, apiUrl, deviceId, now, fetchImpl }) {
    super();
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "edge.db"));
    // Crash safety: WAL keeps readers off the writer's back, and synchronous=FULL
    // fsyncs every commit — a settled bill (cash already taken) must survive a
    // power cut the instant the receipt prints.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 5000");
    this.apiUrl = apiUrl;
    this.now = now || (() => Date.now());
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.forcedOffline = false; // test / UI hook to simulate WAN down
    this._catalogCache = null;
    this._lastContactOk = 0;
    this._migrate();
    if (deviceId) this._setMeta("provisionedId", deviceId);
    if (!this._meta("deviceId")) this._setMeta("deviceId", deviceId || "DEV-" + crypto.randomUUID().slice(0, 8).toUpperCase());
  }

  _migrate() {
    const current = this.db.pragma("user_version", { simple: true });
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        MIGRATIONS[v](this.db);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }
  get schemaVersion() {
    return this.db.pragma("user_version", { simple: true });
  }

  close() {
    this.db.close();
  }

  _iso(ms = this.now()) {
    return new Date(ms).toISOString();
  }
  /** Device clock corrected by the last measured cloud skew — used for fiscal-year and validity decisions. */
  _trueNow() {
    return this.now() + Number(this._meta("clockSkewMs") || 0);
  }

  _meta(k) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(k);
    return row ? row.value : null;
  }
  _setMeta(k, v) {
    if (v === null || v === undefined) this.db.prepare("DELETE FROM meta WHERE key=?").run(k);
    else this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v));
  }

  get deviceId() {
    return this._meta("deviceId");
  }
  get outletId() {
    return this._meta("outletId");
  }
  get activated() {
    return !!this._meta("deviceToken");
  }

  // =====================================================================
  // Catalog (pulled from the cloud change feed)
  // =====================================================================

  /** Apply one feed page atomically: every change and the new cursor commit together or not at all. */
  applyFeed(feed) {
    this.db.transaction(() => {
      if (feed.reset) this.db.exec("DELETE FROM catalog");
      const up = this.db.prepare(
        "INSERT INTO catalog(entity,id,data,seq) VALUES(?,?,?,?) ON CONFLICT(entity,id) DO UPDATE SET data=excluded.data, seq=excluded.seq",
      );
      const del = this.db.prepare("DELETE FROM catalog WHERE entity=? AND id=?");
      for (const c of feed.changes) {
        if (c.op === "delete") del.run(c.entity, c.id);
        else up.run(c.entity, c.id, JSON.stringify(c.data), c.seq);
      }
      this._setMeta("feedCursor", feed.cursor);
      this._setMeta("snapshotAt", this._iso());
    })();
    this._catalogCache = null;
    if (feed.changes.length) this.emit("catalog");
  }

  _catalog() {
    if (this._catalogCache) return this._catalogCache;
    const by = {};
    for (const r of this.db.prepare("SELECT entity,id,data FROM catalog").all()) {
      (by[r.entity] = by[r.entity] || new Map()).set(r.id, JSON.parse(r.data));
    }
    const get = (e) => by[e] || new Map();
    this._catalogCache = {
      settings: get("settings").get("outlet") || null,
      categories: get("category"),
      items: get("item"),
      combos: get("combo"),
      areas: get("area"),
      tables: get("table"),
      staff: get("staff"),
      coupons: get("coupon"),
    };
    return this._catalogCache;
  }

  /**
   * Seed the catalog from a legacy /sync/snapshot payload (pre-feed devices, and
   * the offline smoke tests). Replaces menu/areas wholesale.
   */
  cacheSnapshot(snapshot) {
    const changes = [];
    let seq = 0;
    for (const c of snapshot.menu || []) {
      changes.push({ entity: "category", id: c.id, op: "upsert", seq: ++seq, data: { id: c.id, name: c.name, sortOrder: c.sortOrder || 0, stationId: null, stationName: null } });
      for (const i of c.items || []) changes.push({ entity: "item", id: i.id, op: "upsert", seq: ++seq, data: { ...i, categoryId: c.id, sortOrder: 0 } });
      for (const co of c.combos || []) changes.push({ entity: "combo", id: co.id, op: "upsert", seq: ++seq, data: { ...co, categoryId: c.id } });
    }
    for (const a of snapshot.areas || []) {
      changes.push({ entity: "area", id: a.id, op: "upsert", seq: ++seq, data: { id: a.id, name: a.name } });
      for (const t of a.tables || []) {
        changes.push({ entity: "table", id: t.id, op: "upsert", seq: ++seq, data: { id: t.id, areaId: a.id, name: t.name, seats: t.seats, cloudOccupiedBy: null } });
      }
    }
    const prev = this._catalog().settings || {};
    changes.push({ entity: "settings", id: "outlet", op: "upsert", seq: ++seq, data: { ...prev, themeId: snapshot.themeId || "" } });
    this.db.transaction(() => {
      this.db.exec("DELETE FROM catalog WHERE entity IN ('category','item','combo','area','table')");
      this.applyFeed({ changes, cursor: this._meta("feedCursor") || "0", reset: false });
    })();
  }

  settings() {
    return this._catalog().settings;
  }

  /** Menu in the shape the renderer uses (MenuCategoryDto + station info). */
  menu() {
    const cat = this._catalog();
    const cats = [...cat.categories.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    const items = [...cat.items.values()];
    const combos = [...cat.combos.values()];
    return cats.map((c) => ({
      id: c.id,
      name: c.name,
      sortOrder: c.sortOrder,
      stationId: c.stationId || null,
      stationName: c.stationName || null,
      items: items
        .filter((i) => i.categoryId === c.id)
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name)),
      combos: combos.filter((x) => x.categoryId === c.id).sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }

  /** Floor plan with occupancy: local running orders + what the cloud last reported. */
  areas() {
    const cat = this._catalog();
    const open = new Map(
      this.db
        .prepare("SELECT clientId, tableId, state FROM orders WHERE status='OPEN' AND tableId IS NOT NULL")
        .all()
        .map((r) => [r.tableId, { clientId: r.clientId, total: JSON.parse(r.state).total }]),
    );
    const terminalId = this._meta("terminalId");
    return [...cat.areas.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => ({
        id: a.id,
        name: a.name,
        tables: [...cat.tables.values()]
          .filter((t) => t.areaId === a.id)
          .sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }))
          .map((t) => {
            const local = open.get(t.id) || null;
            const cloud = t.cloudOccupiedBy && t.cloudOccupiedBy.deviceId !== terminalId ? t.cloudOccupiedBy : null;
            return {
              id: t.id,
              name: t.name,
              seats: t.seats,
              occupiedByOrderId: local ? local.clientId : null,
              runningTotal: local ? local.total : null,
              cloudOccupied: !local && !!cloud,
            };
          }),
      }));
  }

  // =====================================================================
  // Offline staff auth (PIN against cached hashes, with lockout)
  // =====================================================================

  staffList() {
    return [...this._catalog().staff.values()]
      .filter((s) => s.isActive)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ id: s.id, name: s.name, roleName: s.roleName, hasPin: !!s.pinHash }));
  }

  /**
   * Verify a staff PIN offline. After PIN_MAX_FAILURES consecutive misses the
   * account locks for 5 min, doubling per repeat lockout (max 1 h). Lockout state
   * is durable, so restarting the sidecar does not reset it.
   */
  async pinLogin(staffId, pin) {
    const staff = this._catalog().staff.get(staffId);
    if (!staff || !staff.isActive) throw new EdgeError("Unknown staff member", 401);
    if (!staff.pinHash) throw new EdgeError("No PIN set for this staff member — set one in Console › Offline POS", 401);
    const att = this.db.prepare("SELECT * FROM pin_attempts WHERE staffId=?").get(staffId) || { failures: 0, lockCount: 0, lockedUntil: null };
    if (att.lockedUntil && Date.parse(att.lockedUntil) > this.now()) {
      const mins = Math.ceil((Date.parse(att.lockedUntil) - this.now()) / 60000);
      throw new EdgeError(`Too many wrong PINs. Locked for ${mins} more minute(s).`, 423);
    }
    const ok = await verifyPin(String(pin || ""), staff.pinHash);
    if (!ok) {
      let { failures, lockCount } = att;
      failures += 1;
      let lockedUntil = null;
      if (failures >= PIN_MAX_FAILURES) {
        lockCount += 1;
        lockedUntil = this._iso(this.now() + Math.min(PIN_LOCK_BASE_MS * 2 ** (lockCount - 1), PIN_LOCK_MAX_MS));
        failures = 0;
      }
      this.db
        .prepare(
          "INSERT INTO pin_attempts(staffId,failures,lockCount,lockedUntil) VALUES(?,?,?,?) ON CONFLICT(staffId) DO UPDATE SET failures=excluded.failures, lockCount=excluded.lockCount, lockedUntil=excluded.lockedUntil",
        )
        .run(staffId, failures, lockCount, lockedUntil);
      throw new EdgeError(lockedUntil ? "Too many wrong PINs — account locked" : `Wrong PIN (${PIN_MAX_FAILURES - failures} attempt(s) left)`, lockedUntil ? 423 : 401);
    }
    this.db.prepare("DELETE FROM pin_attempts WHERE staffId=?").run(staffId);
    const token = crypto.randomBytes(32).toString("base64url");
    this.db
      .prepare("INSERT INTO staff_sessions(tokenHash,staffId,createdAt,expiresAt) VALUES(?,?,?,?)")
      .run(sha256(token), staffId, this._iso(), this._iso(this.now() + SESSION_TTL_MS));
    return { token, staff: this._staffView(staff) };
  }

  _staffView(s) {
    return { id: s.id, name: s.name, roleName: s.roleName, permissions: s.permissions || [] };
  }

  /** Resolve a staff session token; re-reads the cached staff row so a deactivation pulled from the cloud ends the session. */
  resolveSession(token) {
    if (!token) return null;
    const row = this.db.prepare("SELECT * FROM staff_sessions WHERE tokenHash=?").get(sha256(token));
    if (!row || Date.parse(row.expiresAt) <= this.now()) return null;
    const staff = this._catalog().staff.get(row.staffId);
    if (!staff || !staff.isActive) return null;
    return this._staffView(staff);
  }
  logout(token) {
    if (token) this.db.prepare("DELETE FROM staff_sessions WHERE tokenHash=?").run(sha256(token));
    return { ok: true };
  }
  static can(staff, perm) {
    return !!staff && (staff.permissions.includes("*") || staff.permissions.includes(perm));
  }

  // =====================================================================
  // Order lines
  // =====================================================================

  _resolveLine(input) {
    const cat = this._catalog();
    const item = cat.items.get(input.itemId);
    if (!item) throw new EdgeError("Unknown item " + input.itemId);
    if (item.inStock === false) throw new EdgeError(`${item.name} is out of stock`);
    const qty = Number(input.quantity);
    if (!Number.isInteger(qty) || qty < 1) throw new EdgeError("Quantity must be a whole number of at least 1");
    let unitPrice = item.price;
    let variationName = null;
    if (input.variationId) {
      const v = (item.variations || []).find((x) => x.id === input.variationId);
      if (!v) throw new EdgeError(`Invalid variation for ${item.name}`);
      unitPrice = v.price;
      variationName = v.name;
    }
    const addonIds = input.addonIds || [];
    if (new Set(addonIds).size !== addonIds.length) throw new EdgeError("Duplicate addons are not allowed");
    const groups = item.addonGroups || [];
    for (const g of groups) {
      const n = g.addons.filter((a) => addonIds.includes(a.id)).length;
      const min = g.minSelect || 0;
      const max = g.maxSelect ?? 1;
      if (n < min || n > max) throw new EdgeError(`${g.name}: select between ${min} and ${max}`);
    }
    const all = groups.flatMap((g) => g.addons);
    const addonNames = [];
    let unitPaise = toPaise(unitPrice);
    for (const id of addonIds) {
      const a = all.find((x) => x.id === id);
      if (!a) throw new EdgeError(`Invalid addon for ${item.name}`);
      unitPaise += toPaise(a.price);
      addonNames.push(a.name);
    }
    const category = cat.categories.get(item.categoryId);
    const unit = fromPaise(unitPaise);
    return {
      kind: "item",
      itemId: item.id,
      variationId: input.variationId || undefined,
      addonIds,
      quantity: qty,
      note: input.note || undefined,
      itemName: item.name,
      variationName,
      addonNames,
      unitPrice: unit,
      lineTotal: fromPaise(lineTotalPaise(unit, qty)),
      taxRate: item.taxRate,
      stationId: (category && category.stationId) || null,
      stationName: (category && category.stationName) || "Kitchen",
      prepStatus: "PENDING",
      preppedAt: null,
      // Legacy alias so older readers of order state keep working.
      input: { itemId: item.id, variationId: input.variationId, addonIds, quantity: qty, note: input.note },
    };
  }

  _resolveCombo(input) {
    const cat = this._catalog();
    const combo = cat.combos.get(input.comboId);
    if (!combo) throw new EdgeError("Unknown combo " + input.comboId);
    if (combo.inStock === false) throw new EdgeError(`${combo.name} is unavailable`);
    const qty = Number(input.quantity);
    if (!Number.isInteger(qty) || qty < 1) throw new EdgeError("Quantity must be a whole number of at least 1");
    const selections = [];
    const componentNames = [];
    let unitPaise = toPaise(combo.price);
    for (const slot of combo.slots || []) {
      const sel = (input.selections || []).find((s) => s.slotId === slot.id);
      let option = sel ? slot.options.find((o) => o.itemId === sel.itemId) : undefined;
      if (sel && !option) throw new EdgeError(`Invalid choice for ${slot.name}`);
      if (!option) option = slot.options.find((o) => o.isDefault) || slot.options[0];
      if (!option) throw new EdgeError(`${combo.name}: ${slot.name} has no options`);
      if (option.inStock === false) throw new EdgeError(`${option.name} is out of stock`);
      unitPaise += toPaise(option.priceDelta || 0);
      selections.push({ slotId: slot.id, itemId: option.itemId });
      componentNames.push(option.name);
    }
    const category = cat.categories.get(combo.categoryId);
    const unit = fromPaise(unitPaise);
    return {
      kind: "combo",
      comboId: combo.id,
      selections,
      quantity: qty,
      note: input.note || undefined,
      itemName: combo.name,
      variationName: null,
      addonNames: componentNames,
      unitPrice: unit,
      lineTotal: fromPaise(lineTotalPaise(unit, qty)),
      taxRate: combo.taxRate,
      stationId: (category && category.stationId) || null,
      stationName: (category && category.stationName) || "Kitchen",
      prepStatus: "PENDING",
      preppedAt: null,
    };
  }

  _totals(lines, discountAmount) {
    // Delegate to the shared paise formula so edge totals match the server exactly.
    return computeOrderTotals(
      lines.map((l) => ({ lineTotalPaise: toPaise(l.lineTotal), taxRatePercent: l.taxRate })),
      discountAmount || 0,
    );
  }

  // =====================================================================
  // Local order lifecycle
  // =====================================================================

  /**
   * Open an order and fire its first KOT to the LAN kitchen. Dine-in claims the
   * table locally: a table with a running local order cannot be opened twice, and
   * a table the cloud last reported busy (another terminal / QR order) needs an
   * explicit override.
   */
  createOrder({ orderType = "TAKEAWAY", tableId, customerName, customerPhone, deliveryAddress, items = [], combos = [], staffId = null, allowCloudOccupied = false }) {
    if (!ORDER_TYPES.has(orderType)) throw new EdgeError("Invalid order type");
    const lines = [...items.map((i) => this._resolveLine(i)), ...combos.map((c) => this._resolveCombo(c))];
    if (!lines.length) throw new EdgeError("An order needs at least one item or combo");
    let tableName = null;
    if (orderType === "DINE_IN") {
      if (!tableId) throw new EdgeError("Dine-in orders need a table");
      const table = this._catalog().tables.get(tableId);
      if (!table) throw new EdgeError("Unknown table");
      tableName = table.name;
      if (!allowCloudOccupied && table.cloudOccupiedBy && table.cloudOccupiedBy.deviceId !== this._meta("terminalId")) {
        throw new EdgeError(`${table.name} has a running order on another terminal`, 409);
      }
    }
    if (orderType === "DELIVERY" && !(customerPhone && deliveryAddress)) throw new EdgeError("Delivery orders need a phone number and address");
    const at = this._iso();
    const order = {
      clientId: crypto.randomUUID(),
      orderType,
      tableId: orderType === "DINE_IN" ? tableId : null,
      tableName,
      customerName: customerName || null,
      customerPhone: customerPhone || null,
      deliveryAddress: orderType === "DELIVERY" ? deliveryAddress : null,
      lines: [],
      payments: [],
      manualDiscount: 0,
      couponCode: null,
      couponDiscount: 0,
      status: "OPEN",
      billNo: null,
      offlineRef: null,
      kotCount: 0,
      createdAt: at,
      closedAt: null,
      createdByStaffId: staffId,
      closedByStaffId: null,
      clientUpdatedAt: at,
    };
    this.db.transaction(() => {
      if (order.tableId) {
        const busy = this.db.prepare("SELECT 1 FROM orders WHERE tableId=? AND status='OPEN'").get(order.tableId);
        if (busy) throw new EdgeError(`${tableName} already has a running order`, 409);
      }
      this._fire(order, lines);
      this._save(order);
    })();
    this.emit("kds");
    return order;
  }

  /** Add a round to a running order; fires a new KOT. */
  addItems(clientId, { items = [], combos = [], staffId = null } = {}) {
    const lines = [...items.map((i) => this._resolveLine(i)), ...combos.map((c) => this._resolveCombo(c))];
    if (!lines.length) throw new EdgeError("Add at least one item or combo");
    let order;
    this.db.transaction(() => {
      order = this._getOpen(clientId);
      this._fire(order, lines);
      order.lastAddedByStaffId = staffId;
      order.clientUpdatedAt = this._iso();
      this._save(order);
    })();
    this.emit("kds");
    return order;
  }

  /** Append lines as a new KOT and create one LAN ticket per kitchen station. */
  _fire(order, lines) {
    const kotNo = (order.kotCount || 0) + 1;
    order.kotCount = kotNo;
    const base = order.lines.length;
    lines.forEach((l) => (l.kotNo = kotNo));
    order.lines.push(...lines);
    Object.assign(order, this._totals(order.lines, 0), { manualDiscount: 0, couponDiscount: 0 });
    const who = order.customerName ? ` · ${order.customerName}` : "";
    const label = order.orderType === "DINE_IN" ? `Table ${order.tableName}` : order.orderType === "DELIVERY" ? `Delivery${who}` : `Takeaway${who}`;
    const byStation = new Map();
    lines.forEach((l, i) => {
      const k = l.stationId || "none";
      if (!byStation.has(k)) byStation.set(k, { stationId: l.stationId, stationName: l.stationName, items: [] });
      byStation.get(k).items.push({
        lineIndex: base + i,
        name: l.itemName,
        variationName: l.variationName,
        addonNames: l.addonNames,
        quantity: l.quantity,
        note: l.note || null,
      });
    });
    const at = this._iso();
    const ins = this.db.prepare(
      "INSERT INTO kots(id,clientId,kotNo,stationId,stationName,status,items,label,orderType,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const [k, t] of byStation) {
      ins.run(`${order.clientId}:${kotNo}:${k}`, order.clientId, kotNo, t.stationId, t.stationName, "PENDING", JSON.stringify(t.items), label, order.orderType, at, at);
    }
  }

  /** Coupon check against the cached coupon + this device's not-yet-synced redemptions. */
  previewCoupon(code, subtotal) {
    const wanted = String(code || "").trim().toUpperCase();
    const c = [...this._catalog().coupons.values()].find((x) => x.code === wanted) || null;
    let usedCount = c ? c.usedCount : 0;
    if (c && c.usageLimit != null) {
      usedCount += this.db
        .prepare("SELECT state FROM orders WHERE status='SETTLED' AND syncState IN ('local','queued')")
        .all()
        .filter((r) => JSON.parse(r.state).couponCode === c.code).length;
    }
    const res = evaluateCoupon(c ? { ...c, usedCount } : null, subtotal, this._iso(this._trueNow()));
    return {
      ...res,
      code: c ? c.code : null,
      // Usage limits are global across terminals; offline we only know this
      // device's view, so the cloud re-checks on sync and flags any overrun.
      limited: !!(c && c.usageLimit != null),
    };
  }

  /**
   * Settle with any mix of payment modes. Draws the next number from this
   * device's own GST invoice series in the same SQLite transaction that marks
   * the order SETTLED and queues it in the outbox — so a number is never burnt
   * without a bill, and a bill never exists without being queued for the cloud.
   */
  settleOrder(clientId, { payments, discountAmount = 0, couponCode = null, staffId = null } = {}) {
    let order;
    this.db.transaction(() => {
      order = this._getOpen(clientId);
      const subtotal = this._totals(order.lines, 0).subtotal;
      const manual = Number(discountAmount) || 0;
      if (manual < 0 || Math.abs(manual * 100 - toPaise(manual)) > 1e-6) throw new EdgeError("Invalid discount");
      let couponDiscount = 0;
      let code = null;
      if (couponCode) {
        const c = this.previewCoupon(couponCode, subtotal);
        if (!c.valid) throw new EdgeError(c.message);
        couponDiscount = c.discount;
        code = c.code;
      }
      const discount = fromPaise(toPaise(manual) + toPaise(couponDiscount));
      if (discount > subtotal) throw new EdgeError("Discount exceeds the bill");
      const t = this._totals(order.lines, discount);
      if (!Array.isArray(payments) || !payments.length) throw new EdgeError("Add at least one payment");
      for (const p of payments) {
        if (!PAYMENT_MODES.has(p.mode)) throw new EdgeError(`Unsupported payment mode ${p.mode}`);
        if (!(p.amount > 0) || Math.abs(p.amount * 100 - toPaise(p.amount)) > 1e-6) throw new EdgeError("Payment amounts must be positive rupees and paise");
      }
      const paid = payments.reduce((s, p) => s + toPaise(p.amount), 0);
      if (paid !== toPaise(t.total)) throw new EdgeError(`Payments (${fromPaise(paid).toFixed(2)}) must equal total (${t.total.toFixed(2)})`);

      const series = this._meta("seriesCode");
      let billNo = null;
      if (series) {
        const fy = fiscalYearCode(new Date(this._trueNow()));
        const row = this.db.prepare("SELECT lastSeq FROM bill_series WHERE series=? AND fy=?").get(series, fy);
        const seq = (row ? row.lastSeq : 0) + 1;
        this.db
          .prepare("INSERT INTO bill_series(series,fy,lastSeq) VALUES(?,?,?) ON CONFLICT(series,fy) DO UPDATE SET lastSeq=excluded.lastSeq")
          .run(series, fy, seq);
        billNo = { series, fy, seq, number: formatEdgeBillNumber(series, fy, seq) };
      }
      const at = this._iso();
      Object.assign(order, t, {
        payments: payments.map((p) => ({ mode: p.mode, amount: p.amount, ...(p.reference ? { reference: String(p.reference).slice(0, 60) } : {}) })),
        manualDiscount: manual,
        couponCode: code,
        couponDiscount,
        status: "SETTLED",
        billNo,
        // The device invoice number IS the customer's tax invoice; before a device
        // has a series (legacy/dev) a provisional reference is printed instead.
        offlineRef: billNo ? billNo.number : `${(this.deviceId.split("-")[1] || "D").slice(0, 8)}-${this._nextLegacyRef()}`,
        closedAt: at,
        closedByStaffId: staffId,
        clientUpdatedAt: at,
      });
      this._save(order);
      this._enqueue("ORDER", order.clientId, order.clientId, null);
    })();
    return order;
  }

  _nextLegacyRef() {
    const n = Number(this._meta("billSeq") || 0) + 1;
    this._setMeta("billSeq", n);
    return n;
  }

  cancelOrder(clientId, { staffId = null, reason = null } = {}) {
    let order;
    this.db.transaction(() => {
      order = this._getOpen(clientId);
      const at = this._iso();
      Object.assign(order, { status: "CANCELLED", closedAt: at, closedByStaffId: staffId, cancelReason: reason, clientUpdatedAt: at });
      this._save(order);
      this.db.prepare("UPDATE kots SET status='CANCELLED', updatedAt=? WHERE clientId=?").run(at, clientId);
      // Cancelled orders still sync: the kitchen may have cooked, stock moved, and the audit trail needs it.
      this._enqueue("ORDER", order.clientId, order.clientId, null);
    })();
    this.emit("kds");
    return order;
  }

  _getOpen(clientId) {
    const order = this._get(clientId);
    if (!order) throw new EdgeError("Order not found", 404);
    if (order.status !== "OPEN") throw new EdgeError("Order is not open", 409);
    return order;
  }

  _save(order) {
    const { serverId, billNumber, syncState, ...state } = order;
    void serverId;
    void billNumber;
    void syncState;
    this.db
      .prepare(
        `INSERT INTO orders(clientId,state,status,dirty,clientUpdatedAt,serverId,billNumber,createdAt,closedAt,tableId,syncState)
         VALUES(@clientId,@state,@status,0,@clientUpdatedAt,NULL,NULL,@createdAt,@closedAt,@tableId,'local')
         ON CONFLICT(clientId) DO UPDATE SET state=@state,status=@status,clientUpdatedAt=@clientUpdatedAt,closedAt=@closedAt,tableId=@tableId`,
      )
      .run({
        clientId: order.clientId,
        state: JSON.stringify(state),
        status: order.status,
        clientUpdatedAt: order.clientUpdatedAt,
        createdAt: order.createdAt || order.clientUpdatedAt,
        closedAt: order.closedAt || null,
        tableId: order.status === "OPEN" ? order.tableId || null : null,
      });
  }
  _get(clientId) {
    const row = this.db.prepare("SELECT state, serverId, billNumber, syncState FROM orders WHERE clientId=?").get(clientId);
    if (!row) return null;
    const s = JSON.parse(row.state);
    s.serverId = row.serverId;
    s.billNumber = row.billNumber;
    s.syncState = row.syncState;
    return s;
  }
  getOrder(clientId) {
    const o = this._get(clientId);
    if (!o) throw new EdgeError("Order not found", 404);
    return o;
  }

  listOrders({ status } = {}) {
    const rows = status
      ? this.db.prepare("SELECT * FROM orders WHERE status=? ORDER BY clientUpdatedAt DESC LIMIT 200").all(status)
      : this.db.prepare("SELECT * FROM orders ORDER BY clientUpdatedAt DESC LIMIT 200").all();
    return rows.map((r) => {
      const s = JSON.parse(r.state);
      return {
        clientId: r.clientId,
        status: r.status,
        synced: r.syncState === "synced" || r.syncState === "conflict",
        syncState: r.syncState,
        serverId: r.serverId,
        billNumber: r.billNumber, // number the cloud filed the invoice under (= device number unless it had to fall back)
        offlineRef: s.offlineRef, // number printed on the customer's receipt
        total: s.total,
        orderType: s.orderType,
        tableId: s.tableId,
        tableName: s.tableName || null,
        customerName: s.customerName || null,
        lineCount: s.lines.length,
        createdAt: s.createdAt || r.clientUpdatedAt,
        closedAt: s.closedAt || null,
      };
    });
  }

  // =====================================================================
  // Outbox
  // =====================================================================

  _enqueue(kind, key, clientId, payload) {
    const at = this._iso();
    this.db
      .prepare("INSERT OR IGNORE INTO outbox(key,kind,clientId,payload,nextAttemptAt,createdAt) VALUES(?,?,?,?,?,?)")
      .run(key, kind, clientId, payload ? JSON.stringify(payload) : null, at, at);
    if (kind === "ORDER") this.db.prepare("UPDATE orders SET syncState='queued', dirty=1 WHERE clientId=?").run(clientId);
    this.emit("outbox");
  }

  pendingCount() {
    return this.db.prepare("SELECT COUNT(*) c FROM outbox WHERE status='pending'").get().c;
  }

  outbox() {
    return this.db.prepare("SELECT id,key,kind,clientId,status,attempts,nextAttemptAt,lastError,createdAt,doneAt FROM outbox ORDER BY id DESC LIMIT 100").all();
  }

  _orderPayload(o) {
    const items = o.lines.filter((l) => (l.kind || "item") === "item");
    const combos = o.lines.filter((l) => l.kind === "combo");
    const lineBase = (l) => ({
      quantity: l.quantity,
      ...(l.note ? { note: l.note } : {}),
      unitPrice: l.unitPrice,
      taxRate: l.taxRate,
      prepStatus: l.prepStatus || "PENDING",
      preppedAt: l.preppedAt || null,
    });
    return {
      clientId: o.clientId,
      orderType: o.orderType,
      tableId: o.tableId || null,
      customerName: o.customerName || null,
      customerPhone: o.customerPhone || null,
      deliveryAddress: o.deliveryAddress || null,
      items: items.map((l) => {
        const variationId = l.variationId || (l.input && l.input.variationId);
        return {
          itemId: l.itemId || l.input.itemId,
          ...(variationId ? { variationId } : {}),
          addonIds: l.addonIds || (l.input && l.input.addonIds) || [],
          ...lineBase(l),
        };
      }),
      combos: combos.map((l) => ({ comboId: l.comboId, selections: l.selections, ...lineBase(l) })),
      status: o.status,
      payments: o.status === "SETTLED" ? o.payments : [],
      manualDiscount: o.manualDiscount ?? o.discountAmount ?? 0,
      couponCode: o.couponCode || null,
      couponDiscount: o.couponDiscount || 0,
      subtotal: o.subtotal,
      taxAmount: o.taxAmount,
      total: o.total,
      billNo: o.billNo || null,
      createdAt: o.createdAt || o.clientUpdatedAt,
      closedAt: o.closedAt || o.clientUpdatedAt,
      createdByStaffId: o.createdByStaffId || null,
      closedByStaffId: o.closedByStaffId || null,
      cancelReason: o.cancelReason || null,
    };
  }

  _backoffMs(attempts) {
    // 5s, 10s, 20s … capped at 10 min, ±20% jitter so a fleet doesn't retry in lockstep.
    const base = Math.min(5000 * 2 ** Math.max(attempts - 1, 0), 10 * 60 * 1000);
    return Math.round(base * (0.8 + Math.random() * 0.4));
  }

  /** Push due outbox entries in creation order. Throws only on transport/auth failure. */
  async push() {
    let pushed = 0;
    for (let round = 0; round < 20; round++) {
      const due = this.db
        .prepare("SELECT * FROM outbox WHERE status='pending' AND nextAttemptAt <= ? ORDER BY id LIMIT ?")
        .all(this._iso(), PUSH_BATCH);
      if (!due.length) break;
      const ops = [];
      for (const e of due) {
        if (e.kind === "ORDER") {
          const o = this._get(e.clientId);
          if (!o) {
            this.db.prepare("UPDATE outbox SET status='rejected', lastError='order missing locally' WHERE id=?").run(e.id);
            continue;
          }
          ops.push({ kind: "ORDER", key: e.key, order: this._orderPayload(o) });
        } else {
          ops.push({ kind: "KOT_STATUS", key: e.key, clientId: e.clientId, ...JSON.parse(e.payload) });
        }
      }
      if (!ops.length) continue;
      const sentAt = this.now();
      const resp = await this._deviceApi("/edge/device/push", { method: "POST", body: JSON.stringify({ deviceTime: this._iso(sentAt), ops }) });
      this._recordSkew(resp.serverTime, sentAt);
      const byKey = new Map(due.map((e) => [e.key, e]));
      let progressed = false;
      this.db.transaction(() => {
        for (const r of resp.results) {
          const e = byKey.get(r.key);
          if (!e) continue;
          this._applyResult(e, r);
          if (r.status !== "retry") {
            pushed++;
            progressed = true;
          }
        }
      })();
      if (due.length < PUSH_BATCH || !progressed) break;
    }
    this._setMeta("lastPushAt", this._iso());
    return pushed;
  }

  _applyResult(e, r) {
    const at = this._iso();
    if (r.status === "retry") {
      const attempts = e.attempts + 1;
      this.db
        .prepare("UPDATE outbox SET attempts=?, nextAttemptAt=?, lastError=? WHERE id=?")
        .run(attempts, this._iso(this.now() + this._backoffMs(attempts)), r.message || "retry", e.id);
      return;
    }
    const final = r.status === "rejected" ? "rejected" : r.status === "conflict" ? "conflict" : "done";
    this.db
      .prepare("UPDATE outbox SET status=?, attempts=attempts+1, result=?, doneAt=?, lastError=? WHERE id=?")
      .run(final, JSON.stringify(r), at, r.message || null, e.id);
    if (e.kind === "ORDER") {
      const syncState = r.status === "rejected" ? "rejected" : r.status === "conflict" ? "conflict" : "synced";
      this.db
        .prepare("UPDATE orders SET dirty=0, syncState=?, serverId=COALESCE(?,serverId), billNumber=COALESCE(?,billNumber) WHERE clientId=?")
        .run(syncState, r.serverId || null, r.billNumber || null, e.clientId);
      const order = this._get(e.clientId);
      const billNumber = (order && order.offlineRef) || r.billNumber || null;
      const ins = this.db.prepare("INSERT INTO conflicts(clientId,billNumber,kind,message,createdAt) VALUES(?,?,?,?,?)");
      if (r.status === "rejected") ins.run(e.clientId, billNumber, "REJECTED", r.message || "Rejected by the cloud", at);
      for (const c of r.conflicts || []) ins.run(e.clientId, billNumber, c.kind, c.message, at);
    }
  }

  _recordSkew(serverTime, sentAt) {
    const server = Date.parse(serverTime);
    if (Number.isNaN(server)) return;
    // Midpoint of the round trip approximates when the server stamped its time.
    this._setMeta("clockSkewMs", Math.round(server - (sentAt + this.now()) / 2));
  }

  /** Pull the change feed until caught up; each page applies atomically. */
  async pull() {
    let applied = 0;
    for (let page = 0; page < 100; page++) {
      const cursor = this._meta("feedCursor") || "0";
      const sentAt = this.now();
      const feed = await this._deviceApi(`/edge/device/feed?cursor=${encodeURIComponent(cursor)}&limit=500`);
      this._recordSkew(feed.serverTime, sentAt);
      this.applyFeed(feed);
      applied += feed.changes.length;
      if (!feed.hasMore) break;
    }
    this._setMeta("lastPullAt", this._iso());
    return applied;
  }

  /** One push+pull cycle. Throws on transport failure so the caller can back off. */
  async syncOnce() {
    if (!this.activated) throw new EdgeError("Device is not activated");
    try {
      const pushed = await this.push();
      const pulled = await this.pull();
      this._setMeta("lastSyncAt", this._iso());
      this._setMeta("lastError", null);
      this._lastContactOk = this.now();
      return { pushed, pulled, pending: this.pendingCount(), conflicts: this.openConflictCount() };
    } catch (err) {
      this._setMeta("lastError", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
  /** Back-compat name used by the renderer's "Sync now". */
  sync() {
    return this.syncOnce();
  }

  async _deviceApi(pathname, options = {}) {
    if (this.forcedOffline) throw new EdgeError("offline (simulated)", 503);
    const token = this._meta("deviceToken");
    const res = await this.fetch(`${this.apiUrl}${pathname}`, {
      ...options,
      signal: AbortSignal.timeout(20000),
      headers: { "Content-Type": "application/json", Authorization: `Device ${token}`, ...(options.headers || {}) },
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (res.status === 401 || res.status === 403) {
      this._setMeta("authError", (body && body.message) || `HTTP ${res.status}`);
      throw new EdgeError(`Cloud refused this device: ${(body && body.message) || res.status}`, 401);
    }
    if (!res.ok) throw new EdgeError((body && body.message) || `HTTP ${res.status}`, 502);
    this._setMeta("authError", null);
    return body;
  }

  async _userApi(pathname, token, options = {}) {
    if (this.forcedOffline) throw new EdgeError("offline (simulated)", 503);
    const res = await this.fetch(`${this.apiUrl}${pathname}`, {
      ...options,
      signal: AbortSignal.timeout(20000),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) },
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) throw new EdgeError((body && body.message) || `HTTP ${res.status}`, res.status);
    return body;
  }

  /**
   * Bind this device to ONE outlet, activate it for offline billing and pull the
   * catalog. The outlet is chosen explicitly, never by guessing — a terminal that
   * silently attached to the wrong outlet would file its bills against another
   * store. Once bound it stays bound: re-bootstrapping (e.g. to replace a revoked
   * device token) is allowed only for the same outlet. Each activation issues a
   * fresh invoice series.
   */
  async bootstrap({ email, password, outletId }) {
    const login = await this._userApi("/auth/login", null, { method: "POST", body: JSON.stringify({ email, password }) });
    const outlets = await this._userApi("/outlets", login.accessToken);
    if (!Array.isArray(outlets) || outlets.length === 0) throw new EdgeError("This account has no accessible outlets");

    const bound = this.outletId;
    const target = bound ?? outletId ?? (outlets.length === 1 ? outlets[0].id : null);
    if (!target) {
      const list = outlets.map((o) => `${o.id} (${o.name})`).join(", ");
      throw new EdgeError(`This account can access multiple outlets — specify which one to bind this device to. Available: ${list}`);
    }
    if (bound && outletId && outletId !== bound) {
      throw new EdgeError(`Device is already bound to outlet ${bound}; refusing to rebind to ${outletId}. Re-provision (clear device data) to move it.`);
    }
    const outlet = outlets.find((o) => o.id === target);
    if (!outlet) {
      const list = outlets.map((o) => `${o.id} (${o.name})`).join(", ");
      throw new EdgeError(`Outlet ${target} is not accessible to this account. Available: ${list}`);
    }

    const terminalRef = this._meta("terminalId") || this._meta("provisionedId") || undefined;
    const act = await this._userApi(`/outlets/${outlet.id}/edge/activate`, login.accessToken, {
      method: "POST",
      body: JSON.stringify({ ...(terminalRef ? { terminalRef } : {}), name: `Edge ${this.deviceId}`.slice(0, 60) }),
    });
    this.db.transaction(() => {
      this._setMeta("outletId", outlet.id);
      this._setMeta("outletName", outlet.name);
      this._setMeta("deviceToken", act.deviceToken);
      this._setMeta("edgeDeviceId", act.edgeDeviceId);
      this._setMeta("terminalId", act.terminalId);
      this._setMeta("deviceId", act.terminalId);
      this._setMeta("seriesCode", act.seriesCode);
      this._setMeta("authError", null);
    })();
    await this.pull();
    return { outletId: outlet.id, outletName: outlet.name, deviceId: this.deviceId, seriesCode: act.seriesCode };
  }

  async isOnline() {
    if (this.forcedOffline) return false;
    if (this._lastContactOk && this.now() - this._lastContactOk < 90_000) return true;
    try {
      const res = await this.fetch(`${this.apiUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) this._lastContactOk = this.now();
      return res.ok;
    } catch {
      return false;
    }
  }

  // =====================================================================
  // Conflicts surfaced to staff
  // =====================================================================

  openConflictCount() {
    return this.db.prepare("SELECT COUNT(*) c FROM conflicts WHERE acknowledgedAt IS NULL").get().c;
  }
  conflicts() {
    return this.db.prepare("SELECT * FROM conflicts ORDER BY id DESC LIMIT 200").all();
  }
  acknowledgeConflict(id, staffId) {
    this.db.prepare("UPDATE conflicts SET acknowledgedAt=?, acknowledgedBy=? WHERE id=? AND acknowledgedAt IS NULL").run(this._iso(), staffId || null, id);
    return { ok: true };
  }

  status() {
    const settings = this.settings();
    return {
      deviceId: this.deviceId,
      terminalId: this._meta("terminalId"),
      outletId: this.outletId,
      outletName: (settings && settings.name) || this._meta("outletName"),
      activated: this.activated,
      seriesCode: this._meta("seriesCode"),
      pending: this.pendingCount(),
      conflicts: this.openConflictCount(),
      lastSyncAt: this._meta("lastSyncAt"),
      lastPushAt: this._meta("lastPushAt"),
      lastPullAt: this._meta("lastPullAt"),
      lastError: this._meta("lastError"),
      authError: this._meta("authError"),
      snapshotAt: this._meta("snapshotAt"),
      feedCursor: this._meta("feedCursor"),
      clockSkewMs: Number(this._meta("clockSkewMs") || 0),
      themeId: (settings && settings.themeId) || null,
      gstin: (settings && settings.gstin) || null,
      forcedOffline: this.forcedOffline,
      schemaVersion: this.schemaVersion,
    };
  }

  // =====================================================================
  // LAN kitchen display
  // =====================================================================

  kdsTickets() {
    const cutoff = this._iso(this.now() - READY_WINDOW_MS);
    return this.db
      .prepare("SELECT * FROM kots WHERE status IN ('PENDING','PREPARING') OR (status='READY' AND readyAt >= ?) ORDER BY createdAt")
      .all(cutoff)
      .map((k) => ({ ...k, items: JSON.parse(k.items) }));
  }

  /** Bump a LAN ticket. Mirrors the status onto the order lines; synced orders queue a cloud update. */
  advanceTicket(kotId, toStatus) {
    if (!["PENDING", "PREPARING", "READY"].includes(toStatus)) throw new EdgeError("Invalid status");
    this.db.transaction(() => {
      const kot = this.db.prepare("SELECT * FROM kots WHERE id=?").get(kotId);
      if (!kot || kot.status === "CANCELLED") throw new EdgeError("Ticket not found", 404);
      const at = this._iso();
      this.db.prepare("UPDATE kots SET status=?, updatedAt=?, readyAt=? WHERE id=?").run(toStatus, at, toStatus === "READY" ? at : null, kotId);
      const order = this._get(kot.clientId);
      if (!order) return;
      for (const it of JSON.parse(kot.items)) {
        const line = order.lines[it.lineIndex];
        if (line) Object.assign(line, { prepStatus: toStatus, preppedAt: toStatus === "READY" ? at : null });
      }
      this._save(order);
      // Before the order's own push, its payload carries these statuses; once the
      // cloud has accepted it, kitchen progress travels as a KOT_STATUS op.
      const sent = this.db.prepare("SELECT status FROM outbox WHERE kind='ORDER' AND clientId=?").get(kot.clientId);
      if (sent && (sent.status === "done" || sent.status === "conflict")) {
        const counters = { item: 0, combo: 0 };
        const lines = order.lines.map((l) => {
          const kind = l.kind === "combo" ? "combo" : "item";
          return { lineIndex: counters[kind]++, kind, prepStatus: l.prepStatus || "PENDING", preppedAt: l.preppedAt || null };
        });
        this._enqueue("KOT_STATUS", `${kot.clientId}:kot:${crypto.randomUUID()}`, kot.clientId, { lines });
      }
    })();
    this.emit("kds");
    return { ok: true };
  }

  /** One-time 6-digit code shown on the POS; a kitchen screen redeems it for a long-lived token. */
  createPairingCode() {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = this._iso(this.now() + PAIRING_TTL_MS);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM kds_pairing WHERE expiresAt <= ?").run(this._iso());
      this.db.prepare("INSERT OR REPLACE INTO kds_pairing(codeHash,expiresAt,failures) VALUES(?,?,0)").run(sha256(code), expiresAt);
    })();
    return { code, expiresAt };
  }

  pairScreen({ code, name }) {
    const live = this.db.prepare("SELECT * FROM kds_pairing WHERE expiresAt > ?").all(this._iso());
    const match = live.find((p) => p.codeHash === sha256(String(code || "")));
    if (!match) {
      // Every miss counts against all live codes; 5 misses burn them (brute-force guard).
      for (const p of live) {
        if (p.failures + 1 >= 5) this.db.prepare("DELETE FROM kds_pairing WHERE codeHash=?").run(p.codeHash);
        else this.db.prepare("UPDATE kds_pairing SET failures=failures+1 WHERE codeHash=?").run(p.codeHash);
      }
      throw new EdgeError("Invalid or expired pairing code", 401);
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const id = crypto.randomUUID();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM kds_pairing WHERE codeHash=?").run(match.codeHash);
      this.db
        .prepare("INSERT INTO kds_screens(id,name,tokenHash,createdAt) VALUES(?,?,?,?)")
        .run(id, String(name || "Kitchen screen").slice(0, 40), sha256(token), this._iso());
    })();
    return { token, screenId: id };
  }

  verifyScreen(token) {
    if (!token) return null;
    const s = this.db.prepare("SELECT * FROM kds_screens WHERE tokenHash=? AND revokedAt IS NULL").get(sha256(token));
    if (!s) return null;
    this.db.prepare("UPDATE kds_screens SET lastSeenAt=? WHERE id=?").run(this._iso(), s.id);
    return { id: s.id, name: s.name };
  }
  listScreens() {
    return this.db.prepare("SELECT id,name,createdAt,lastSeenAt,revokedAt FROM kds_screens ORDER BY createdAt DESC").all();
  }
  revokeScreen(id) {
    this.db.prepare("UPDATE kds_screens SET revokedAt=? WHERE id=? AND revokedAt IS NULL").run(this._iso(), id);
    this.emit("kds-revoked", id);
    return { ok: true };
  }

  // =====================================================================
  // Retention
  // =====================================================================

  /**
   * Bound local storage. Only data the cloud has durably accepted is removed:
   * unsynced, rejected or open orders and pending outbox entries are kept
   * indefinitely, whatever their age.
   */
  purge({ orderDays = 30, outboxDays = 7 } = {}) {
    const orderCutoff = this._iso(this.now() - orderDays * 86400000);
    const outboxCutoff = this._iso(this.now() - outboxDays * 86400000);
    const res = {};
    this.db.transaction(() => {
      res.orders = this.db
        .prepare("DELETE FROM orders WHERE status IN ('SETTLED','CANCELLED') AND syncState IN ('synced','conflict') AND COALESCE(closedAt, clientUpdatedAt) < ?")
        .run(orderCutoff).changes;
      res.outbox = this.db.prepare("DELETE FROM outbox WHERE status IN ('done','conflict') AND doneAt < ?").run(outboxCutoff).changes;
      res.kots = this.db
        .prepare("DELETE FROM kots WHERE updatedAt < ? AND clientId NOT IN (SELECT clientId FROM orders WHERE status='OPEN')")
        .run(this._iso(this.now() - 2 * 86400000)).changes;
      res.sessions = this.db.prepare("DELETE FROM staff_sessions WHERE expiresAt <= ?").run(this._iso()).changes;
      this.db.prepare("DELETE FROM kds_pairing WHERE expiresAt <= ?").run(this._iso());
      res.conflicts = this.db.prepare("DELETE FROM conflicts WHERE acknowledgedAt IS NOT NULL AND acknowledgedAt < ?").run(orderCutoff).changes;
    })();
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    return res;
  }
}

module.exports = { EdgeEngine, EdgeError, MIGRATIONS };
