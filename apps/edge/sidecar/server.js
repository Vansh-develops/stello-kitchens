"use strict";
// Local master service: exposes the offline-first engine over HTTP so the renderer
// (and other LAN terminals) can bill even with the WAN down. Runs a background sync
// loop that drains the outbox whenever the cloud is reachable.

const path = require("node:path");
const express = require("express");
const { EdgeEngine } = require("./engine");

const PORT = Number(process.env.EDGE_PORT || 4010);
const API_URL = process.env.MAIN_API_URL || "http://localhost:3001/api/v1";
const DATA_DIR = process.env.EDGE_DATA_DIR || path.join(__dirname, "..", "edge-data");

const engine = new EdgeEngine({ dataDir: DATA_DIR, apiUrl: API_URL });
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : "error" });
  }
};

app.get("/status", wrap(async () => ({ ...engine.status(), online: await engine.isOnline() })));
app.post("/bootstrap", wrap((req) => engine.bootstrap(req.body)));
app.get("/menu", wrap(async () => engine.menu()));
app.get("/areas", wrap(async () => engine.areas()));
app.get("/orders", wrap(async () => engine.listOrders()));
app.post("/orders", wrap(async (req) => engine.createOrder(req.body)));
app.post("/orders/:clientId/settle", wrap(async (req) => engine.settleOrder(req.params.clientId, req.body)));
app.post("/orders/:clientId/cancel", wrap(async (req) => engine.cancelOrder(req.params.clientId)));
app.post("/sync", wrap(async () => engine.sync()));
app.post("/offline", wrap(async (req) => {
  engine.forcedOffline = !!req.body.offline;
  return { forcedOffline: engine.forcedOffline };
}));

// Background sync loop — drain the outbox when connectivity allows.
let syncing = false;
setInterval(async () => {
  if (syncing || engine.forcedOffline || !engine.outletId) return;
  syncing = true;
  try {
    await engine.sync();
  } catch {
    /* stay offline-tolerant; retry next tick */
  } finally {
    syncing = false;
  }
}, 10_000);

app.listen(PORT, () => {
  console.log(`Edge master service on http://localhost:${PORT} (device ${engine.deviceId}, api ${API_URL})`);
});
