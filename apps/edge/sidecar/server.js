"use strict";
// Local master service: exposes the offline-first engine over HTTP so the renderer
// (and other LAN terminals) can bill even with the WAN down. Runs a background sync
// loop that drains the outbox whenever the cloud is reachable.

const path = require("node:path");
const express = require("express");
const { EdgeEngine } = require("./engine");
const { createPrintRouter, startPullLoop } = require("./print-agent");

const PORT = Number(process.env.EDGE_PORT || 4010);
const HOST = process.env.EDGE_HOST || "127.0.0.1";
const API_URL = process.env.MAIN_API_URL || "http://localhost:3001/api/v1";
const DATA_DIR = process.env.EDGE_DATA_DIR || path.join(__dirname, "..", "edge-data");
// Which outlet this terminal is provisioned for. Set at install time; the caller
// may still pass an explicit outletId in the bootstrap body to override for setup.
const OUTLET_ID = process.env.EDGE_OUTLET_ID || undefined;
// Provision this value from the API device fleet (terminal id or deviceToken).
// A generated development id is intentionally rejected by the cloud sync API.
const DEVICE_ID = process.env.EDGE_DEVICE_ID || undefined;
const SIDECAR_TOKEN = process.env.EDGE_SIDECAR_TOKEN ||
  (process.env.NODE_ENV === "production" ? "" : "dev-edge-sidecar-token");
if (!SIDECAR_TOKEN) throw new Error("EDGE_SIDECAR_TOKEN is required in production");
const ALLOWED_ORIGINS = new Set(
  (process.env.EDGE_CORS_ORIGINS || "http://localhost:5175,http://127.0.0.1:5175,null")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

// Print agent: the cloud dashboard (POS/KDS in a browser) sends jobs to /print on
// this machine. It is a different caller from the renderer above, so it has its
// own key and origin allow-list. The key is shared with the POS via its
// "Printing on this device" setting.
const PRINT_KEY = process.env.EDGE_PRINT_KEY ||
  (process.env.NODE_ENV === "production" ? "" : "dev-print-key");
const PRINT_ORIGINS = new Set(
  (process.env.EDGE_PRINT_ORIGINS || "https://kitchens.stellotechs.com,http://localhost:3002,http://127.0.0.1:3002")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
// Pull loop: claim this outlet's queued NETWORK/USB jobs from the cloud.
const PRINT_POLL = process.env.EDGE_PRINT_POLL !== "0";
const PRINT_PRINTERS = (process.env.EDGE_PRINT_PRINTERS || "").split(",").map((s) => s.trim()).filter(Boolean);

const engine = new EdgeEngine({ dataDir: DATA_DIR, apiUrl: API_URL, deviceId: DEVICE_ID });
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
// Mounted before the renderer CORS/token gate: it carries its own.
if (PRINT_KEY) app.use("/print", createPrintRouter({ key: PRINT_KEY, allowedOrigins: PRINT_ORIGINS, agentId: engine.deviceId }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ message: "Origin not allowed" });
  if (origin) res.header("Access-Control-Allow-Origin", origin);
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Edge-Token");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use((req, res, next) => {
  if (req.headers["x-edge-token"] !== SIDECAR_TOKEN) {
    return res.status(401).json({ message: "Invalid edge session" });
  }
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
app.post("/bootstrap", wrap((req) => engine.bootstrap({ outletId: OUTLET_ID, ...req.body })));
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

if (PRINT_POLL) {
  startPullLoop({
    api: (pathname, options) => engine._api(pathname, options),
    outletId: () => engine.outletId,
    agentId: engine.deviceId,
    printerIds: PRINT_PRINTERS.length ? PRINT_PRINTERS : null,
  });
}

app.listen(PORT, HOST, () => {
  console.log(`Edge master service on http://${HOST}:${PORT} (device ${engine.deviceId}, api ${API_URL})`);
});
