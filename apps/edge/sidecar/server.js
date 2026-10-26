"use strict";
// Local master service. Two HTTP listeners:
//  1. POS API on 127.0.0.1:EDGE_PORT — the renderer's only backend (sidecar token
//     + per-staff PIN session). Works identically online and offline.
//  2. LAN kitchen display on EDGE_LAN_HOST:EDGE_LAN_PORT — serves a lightweight
//     KDS page and its ticket API/SSE stream to paired kitchen screens, so the
//     kitchen keeps working when the internet is down.
// A background push+pull loop drains the outbox and pulls the change feed with
// exponential backoff whenever the cloud is unreachable.

const path = require("node:path");
const os = require("node:os");
const express = require("express");
const { EdgeEngine, EdgeError } = require("./engine");

const PORT = Number(process.env.EDGE_PORT || 4010);
const HOST = process.env.EDGE_HOST || "127.0.0.1";
const LAN_PORT = Number(process.env.EDGE_LAN_PORT ?? 4011); // 0 disables the LAN KDS
const LAN_HOST = process.env.EDGE_LAN_HOST || "0.0.0.0";
const API_URL = process.env.MAIN_API_URL || "http://localhost:3001/api/v1";
const DATA_DIR = process.env.EDGE_DATA_DIR || path.join(__dirname, "..", "edge-data");
const SYNC_INTERVAL_MS = Number(process.env.EDGE_SYNC_INTERVAL_MS || 15000);
const RETENTION_DAYS = Number(process.env.EDGE_RETENTION_DAYS || 30);
// Which outlet this terminal is provisioned for. Set at install time; the caller
// may still pass an explicit outletId in the bootstrap body to override for setup.
const OUTLET_ID = process.env.EDGE_OUTLET_ID || undefined;
// Provision this value from the API device fleet (terminal id or deviceToken).
// Without it, first activation registers a new POS terminal (needs devices.manage).
const DEVICE_ID = process.env.EDGE_DEVICE_ID || undefined;
const SIDECAR_TOKEN = process.env.EDGE_SIDECAR_TOKEN || (process.env.NODE_ENV === "production" ? "" : "dev-edge-sidecar-token");
if (!SIDECAR_TOKEN) throw new Error("EDGE_SIDECAR_TOKEN is required in production");
const ALLOWED_ORIGINS = new Set(
  (process.env.EDGE_CORS_ORIGINS || "http://localhost:5175,http://127.0.0.1:5175,null")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

function createServers(engine, { sidecarToken = SIDECAR_TOKEN, allowedOrigins = ALLOWED_ORIGINS, outletId = OUTLET_ID, loopOptions } = {}) {
  // ------------------------------------------------------------------ POS API
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ message: "Origin not allowed" });
    if (origin) res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Headers", "Content-Type, X-Edge-Token, X-Staff-Session");
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  app.use((req, res, next) => {
    if (req.headers["x-edge-token"] !== sidecarToken) return res.status(401).json({ message: "Invalid edge session" });
    next();
  });

  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      const status = err instanceof EdgeError ? err.status : 400;
      res.status(status >= 400 && status < 600 ? status : 400).json({ message: err instanceof Error ? err.message : "error" });
    }
  };
  /** Require a PIN session (and optionally a permission); attaches req.staff. */
  const staff = (perm) => (req, res, next) => {
    const s = engine.resolveSession(req.headers["x-staff-session"]);
    if (!s) return res.status(401).json({ message: "Staff login required", code: "STAFF_LOGIN" });
    if (perm && !EdgeEngine.can(s, perm)) return res.status(403).json({ message: `Your role cannot do this (${perm})` });
    req.staff = s;
    next();
  };

  app.get("/status", wrap(async () => ({ ...engine.status(), online: await engine.isOnline(), lanKds: lanInfo() })));
  app.post("/bootstrap", wrap((req) => engine.bootstrap({ outletId, ...req.body })));
  app.get("/menu", wrap(async () => engine.menu()));
  app.get("/areas", wrap(async () => engine.areas()));
  app.get("/settings", wrap(async () => engine.settings()));

  app.get("/staff", wrap(async () => engine.staffList()));
  app.post("/auth/pin", wrap((req) => engine.pinLogin(req.body.staffId, req.body.pin)));
  app.get("/auth/me", staff(), wrap(async (req) => req.staff));
  app.post("/auth/logout", wrap(async (req) => engine.logout(req.headers["x-staff-session"])));

  app.get("/orders", staff(), wrap(async (req) => engine.listOrders({ status: req.query.status || undefined })));
  app.get("/orders/:clientId", staff(), wrap(async (req) => engine.getOrder(req.params.clientId)));
  app.post("/orders", staff("orders.create"), wrap(async (req) => engine.createOrder({ ...req.body, staffId: req.staff.id })));
  app.post("/orders/:clientId/items", staff("orders.create"), wrap(async (req) => engine.addItems(req.params.clientId, { ...req.body, staffId: req.staff.id })));
  app.post("/orders/:clientId/settle", staff("orders.settle"), wrap(async (req) => engine.settleOrder(req.params.clientId, { ...req.body, staffId: req.staff.id })));
  app.post("/orders/:clientId/cancel", staff("orders.cancel"), wrap(async (req) => engine.cancelOrder(req.params.clientId, { reason: req.body.reason, staffId: req.staff.id })));
  app.post("/coupons/preview", staff(), wrap(async (req) => engine.previewCoupon(req.body.code, Number(req.body.subtotal) || 0)));

  app.get("/sync/state", staff(), wrap(async () => ({ status: { ...engine.status(), online: await engine.isOnline() }, outbox: engine.outbox(), conflicts: engine.conflicts() })));
  app.post("/sync", staff(), wrap(async () => loop.runNow()));
  app.post("/conflicts/:id/ack", staff(), wrap(async (req) => engine.acknowledgeConflict(Number(req.params.id), req.staff.id)));
  app.post(
    "/offline",
    staff(),
    wrap(async (req) => {
      engine.forcedOffline = !!req.body.offline;
      if (!engine.forcedOffline) loop.kick();
      return { forcedOffline: engine.forcedOffline };
    }),
  );

  app.get("/kds/tickets", staff(), wrap(async () => engine.kdsTickets()));
  app.post("/kds/pairing-code", staff(), wrap(async () => ({ ...engine.createPairingCode(), lan: lanInfo() })));
  app.get("/kds/screens", staff(), wrap(async () => engine.listScreens()));
  app.post("/kds/screens/:id/revoke", staff(), wrap(async (req) => engine.revokeScreen(req.params.id)));

  // ------------------------------------------------------------- LAN KDS
  const lan = express();
  lan.disable("x-powered-by");
  lan.use(express.json({ limit: "16kb" }));
  lan.use((_req, res, next) => {
    res.header("X-Frame-Options", "DENY");
    res.header("Cache-Control", "no-store");
    next();
  });
  const page = path.join(__dirname, "kds", "index.html");
  lan.get("/", (_req, res) => res.sendFile(page));
  lan.get("/kds", (_req, res) => res.sendFile(page));

  // Coarse per-IP throttle on pairing on top of the engine's per-code burn-out.
  const pairHits = new Map();
  lan.post("/api/pair", (req, res) => {
    const ip = req.socket.remoteAddress || "?";
    const now = Date.now();
    const hits = (pairHits.get(ip) || []).filter((t) => now - t < 60_000);
    if (hits.length >= 10) return res.status(429).json({ message: "Too many attempts, wait a minute" });
    pairHits.set(ip, [...hits, now]);
    try {
      res.json(engine.pairScreen({ code: req.body && req.body.code, name: req.body && req.body.name }));
    } catch (err) {
      res.status(err.status || 400).json({ message: err.message });
    }
  });
  const screen = (req, res, next) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : req.query.token;
    const s = engine.verifyScreen(typeof token === "string" ? token : "");
    if (!s) return res.status(401).json({ message: "Screen not paired" });
    req.screen = s;
    next();
  };
  const outletName = () => (engine.settings() && engine.settings().name) || engine.status().outletName || "Kitchen";
  lan.get("/api/tickets", screen, (req, res) => res.json({ outlet: outletName(), screen: req.screen, tickets: engine.kdsTickets() }));
  lan.post("/api/tickets/:id/status", screen, (req, res) => {
    try {
      res.json(engine.advanceTicket(req.params.id, req.body && req.body.status));
    } catch (err) {
      res.status(err.status || 400).json({ message: err.message });
    }
  });

  // Server-sent events: one push per KDS change plus a heartbeat, so screens
  // update instantly without polling and notice a dead sidecar quickly.
  const streams = new Set();
  lan.get("/api/stream", screen, (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const client = {
      res,
      screenId: req.screen.id,
      send: () => res.write(`event: tickets\ndata: ${JSON.stringify({ outlet: outletName(), tickets: engine.kdsTickets() })}\n\n`),
    };
    streams.add(client);
    client.send();
    const hb = setInterval(() => res.write(": hb\n\n"), 15000);
    req.on("close", () => {
      clearInterval(hb);
      streams.delete(client);
    });
  });
  let coalesce = null;
  engine.on("kds", () => {
    // Coalesce bursts (a round fires several station tickets at once).
    if (coalesce) return;
    coalesce = setTimeout(() => {
      coalesce = null;
      for (const c of streams) c.send();
    }, 50);
  });
  engine.on("kds-revoked", (id) => {
    for (const c of streams) if (c.screenId === id) c.res.end();
  });

  let lanAddress = null;
  function lanInfo() {
    if (!lanAddress) return null;
    const ips = Object.values(os.networkInterfaces())
      .flat()
      .filter((n) => n && n.family === "IPv4" && !n.internal)
      .map((n) => n.address);
    return { port: lanAddress.port, urls: ips.map((ip) => `http://${ip}:${lanAddress.port}/`) };
  }

  const loop = createSyncLoop(engine, loopOptions);
  return {
    app,
    lan,
    loop,
    setLanAddress: (a) => (lanAddress = a),
    closeStreams: () => {
      for (const c of streams) c.res.end();
    },
  };
}

/**
 * Push+pull scheduler. Runs every SYNC_INTERVAL_MS while healthy; on failure it
 * backs off exponentially (5 s → 5 min, jittered). A new outbox entry nudges an
 * early run so sales reach the cloud within seconds when it is reachable.
 */
function createSyncLoop(engine, { intervalMs = SYNC_INTERVAL_MS, retentionDays = RETENTION_DAYS } = {}) {
  let timer = null;
  let running = null;
  let failures = 0;
  let lastPurge = Date.now();
  let stopped = true;

  const schedule = (ms) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => tick().catch(() => {}), ms);
    if (timer.unref) timer.unref();
  };
  function tick() {
    if (running) return running;
    if (engine.forcedOffline || !engine.activated) {
      schedule(intervalMs);
      return Promise.reject(new EdgeError(engine.forcedOffline ? "Offline (simulated)" : "Device is not activated", 503));
    }
    running = (async () => {
      try {
        const r = await engine.syncOnce();
        failures = 0;
        if (Date.now() - lastPurge > 6 * 3600_000) {
          engine.purge({ orderDays: retentionDays });
          lastPurge = Date.now();
        }
        schedule(intervalMs);
        return r;
      } catch (err) {
        failures += 1;
        schedule(Math.round(Math.min(5000 * 2 ** (failures - 1), 5 * 60_000) * (0.8 + Math.random() * 0.4)));
        throw err;
      } finally {
        running = null;
      }
    })();
    return running;
  }
  engine.on("outbox", () => schedule(1000));
  return {
    start: () => {
      stopped = false;
      schedule(1000);
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
    kick: () => schedule(0),
    runNow: () => tick(),
    get failures() {
      return failures;
    },
  };
}

module.exports = { createServers, createSyncLoop };

if (require.main === module) {
  const engine = new EdgeEngine({ dataDir: DATA_DIR, apiUrl: API_URL, deviceId: DEVICE_ID });
  const servers = createServers(engine);
  servers.app.listen(PORT, HOST, () => {
    console.log(`Edge master service on http://${HOST}:${PORT} (device ${engine.deviceId}, api ${API_URL})`);
  });
  if (LAN_PORT > 0) {
    const lanServer = servers.lan.listen(LAN_PORT, LAN_HOST, () => {
      servers.setLanAddress(lanServer.address());
      console.log(`LAN kitchen display on http://${LAN_HOST}:${LAN_PORT}/ (pair screens with a code from the POS)`);
    });
  }
  try {
    console.log("Retention purge:", JSON.stringify(engine.purge({ orderDays: RETENTION_DAYS })));
  } catch (err) {
    console.error("Retention purge failed:", err);
  }
  servers.loop.start();
  const shutdown = () => {
    servers.loop.stop();
    servers.closeStreams();
    engine.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
