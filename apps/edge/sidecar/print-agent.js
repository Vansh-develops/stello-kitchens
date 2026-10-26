"use strict";
// Edge print agent. The cloud API can't reach printers on the restaurant LAN, so
// this sidecar does the last hop: it renders print jobs to ESC/POS bytes with the
// shared encoder and writes them to the printer.
//
//   NETWORK — raw TCP to the printer's port (9100, "JetDirect"/AppSocket).
//   USB     — write bytes to a device path: /dev/usb/lp0 on Linux, or on Windows
//             a printer shared with a Generic/Text-Only (raw) driver, addressed as
//             \\localhost\<ShareName>. No native USB library is needed.
//
// Two ways in:
//   1. HTTP  — a POS browser on this machine POSTs jobs to /print/* (see router).
//   2. Pull  — a background loop claims queued jobs from the cloud for this
//              outlet's NETWORK/USB printers (KOTs from scan/aggregator orders,
//              punches from other terminals) and reports the outcome.

const net = require("node:net");
const fs = require("node:fs");
const express = require("express");
const { renderPayload, encodePrintDoc } = require("@stello/shared");

const TCP_TIMEOUT_MS = 8000;

/** Send bytes to a raw TCP printer; resolves once the socket has flushed and closed. */
function sendTcp(host, port, bytes, timeoutMs = TCP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: Number(port) || 9100 });
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(timeoutMs, () => done(new Error(`Printer ${host}:${port} timed out`)));
    socket.on("error", (err) => done(new Error(`Printer ${host}:${port}: ${err.code || err.message}`)));
    socket.on("connect", () => {
      // end() flushes the write then half-closes; most printers close in turn.
      socket.end(Buffer.from(bytes), () => setTimeout(() => done(), 50));
    });
    socket.on("close", () => done());
  });
}

/** Write bytes to a local device path or Windows printer share. */
function sendDevice(path, bytes) {
  if (!path) return Promise.reject(new Error("USB printer has no device path"));
  return fs.promises.writeFile(path, Buffer.from(bytes));
}

/** Render a job for its printer. Drawer kicks are honoured once, not per copy. */
function renderJob(printer, job) {
  const doc = renderPayload(job.payload, {
    paperWidth: printer.paperWidth === 58 ? 58 : 80,
    openDrawer: !!job.openDrawer,
    timeZone: process.env.EDGE_PRINT_TZ || "Asia/Kolkata",
  });
  return encodePrintDoc(doc, { codepage: printer.codepage || "CP437", copies: job.payload.kind === "DRAWER" ? 1 : job.copies || 1 });
}

async function deliver(printer, bytes) {
  if (printer.connection === "NETWORK") return sendTcp(printer.host, printer.port, bytes);
  if (printer.connection === "USB") return sendDevice(printer.usbPath, bytes);
  throw new Error(`The agent can't drive ${printer.connection} printers`);
}

async function printJob(printer, job) {
  await deliver(printer, renderJob(printer, job));
}

// ---------- HTTP (browser → local agent) ----------

/**
 * Express router mounted at /print. Separate from the sidecar's renderer API:
 * the caller is the cloud dashboard in a browser, so it has its own origin
 * allow-list and key, and answers Chrome's Private Network Access preflight.
 */
function createPrintRouter({ key, allowedOrigins, agentId }) {
  const router = express.Router();
  router.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ message: "Origin not allowed" });
    if (origin) res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Headers", "Content-Type, X-Print-Key");
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    // https://kitchens… → http://127.0.0.1 is a public→local request in Chrome.
    if (req.headers["access-control-request-private-network"]) res.header("Access-Control-Allow-Private-Network", "true");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    if (!key || req.headers["x-print-key"] !== key) return res.status(401).json({ message: "Invalid print key" });
    next();
  });

  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      res.status(502).json({ message: err instanceof Error ? err.message : "Print failed" });
    }
  };

  router.get("/health", wrap(async () => ({ ok: true, agentId, connections: ["NETWORK", "USB"] })));
  // { printer: PrinterDto, job: { payload, copies, openDrawer } }
  router.post("/job", wrap(async (req) => {
    const { printer, job } = req.body || {};
    if (!printer || !job || !job.payload) throw new Error("printer and job are required");
    await printJob(printer, job);
    return { ok: true };
  }));
  // { printer, base64 } — raw bytes, for callers that render themselves.
  router.post("/raw", wrap(async (req) => {
    const { printer, base64 } = req.body || {};
    if (!printer || typeof base64 !== "string") throw new Error("printer and base64 are required");
    await deliver(printer, Buffer.from(base64, "base64"));
    return { ok: true };
  }));
  return router;
}

// ---------- Pull loop (cloud queue → LAN printers) ----------

/**
 * Claim and deliver queued jobs for this outlet's NETWORK/USB printers. The
 * claim is atomic server-side, so several agents (or a browser relay) can poll
 * the same outlet without double printing. `api(path, init)` is the engine's
 * authenticated cloud fetch.
 */
function startPullLoop({ api, outletId, agentId, printerIds, intervalMs = 3000, log = console }) {
  let busy = false;
  const tick = async () => {
    const outlet = outletId();
    if (busy || !outlet) return;
    busy = true;
    try {
      const jobs = await api(`/outlets/${outlet}/print-jobs/claim`, {
        method: "POST",
        body: JSON.stringify({ agentId, connections: ["NETWORK", "USB"], printerIds: printerIds || undefined, limit: 10 }),
      });
      for (const job of jobs) {
        let result;
        try {
          if (!job.printer) throw new Error("Printer was removed");
          await printJob(job.printer, job);
          result = { ok: true, agentId };
        } catch (err) {
          result = { ok: false, agentId, error: err instanceof Error ? err.message : String(err) };
          log.warn(`[print] job ${job.id} failed: ${result.error}`);
        }
        await api(`/print-jobs/${job.id}/complete`, { method: "POST", body: JSON.stringify(result) }).catch((err) =>
          log.warn(`[print] could not report job ${job.id}: ${err.message}`),
        );
      }
    } catch {
      /* offline or not signed in: retry next tick */
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  return { stop: () => clearInterval(timer), tick };
}

module.exports = { sendTcp, sendDevice, renderJob, printJob, createPrintRouter, startPullLoop };
