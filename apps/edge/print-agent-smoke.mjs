// Print agent smoke: a fake raw-TCP printer (port 9100 stand-in) receives the
// ESC/POS bytes the agent renders, via the HTTP endpoint and the pull loop.
// Run: node apps/edge/print-agent-smoke.mjs   (needs @stello/shared built)
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const express = require("express");
const { createPrintRouter, startPullLoop, sendTcp, sendDevice } = require("./sidecar/print-agent.js");

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`);
  if (!cond) failures++;
};

// A fake printer: collects every connection's bytes.
const received = [];
const printer = net.createServer((sock) => {
  const chunks = [];
  sock.on("data", (c) => chunks.push(c));
  sock.on("end", () => {
    received.push(Buffer.concat(chunks));
    sock.end();
  });
});
await new Promise((r) => printer.listen(0, "127.0.0.1", r));
const printerPort = printer.address().port;
const lanPrinter = { id: "p1", connection: "NETWORK", host: "127.0.0.1", port: printerPort, paperWidth: 80, codepage: "CP858" };

const ticket = {
  outletName: "Kor", kotNumber: 7, orderType: "DINE_IN", tableName: "T4", stationName: "Tandoor", orderRef: "#ABC",
  source: "POS", customerName: null, staffName: "Ravi", createdAt: new Date().toISOString(),
  items: [{ name: "Butter Naan", variationName: null, quantity: 2, addons: [], note: null }], reprint: false, cancelled: false,
};

console.log("\n[1] Raw TCP");
await sendTcp("127.0.0.1", printerPort, [0x1b, 0x40, 0x41, 0x0a]);
ok(received.at(-1)?.equals(Buffer.from([0x1b, 0x40, 0x41, 0x0a])), "bytes arrive verbatim");
let err = null;
await sendTcp("127.0.0.1", 1, [0x41], 1500).catch((e) => (err = e));
ok(err && /127\.0\.0\.1:1/.test(err.message), `unreachable printer reports an error (${err?.message})`);

console.log("\n[2] Device path (USB stand-in)");
const devFile = path.join(os.tmpdir(), `stello-lp-${Date.now()}.bin`);
await sendDevice(devFile, [0x1b, 0x40]);
ok(fs.readFileSync(devFile).equals(Buffer.from([0x1b, 0x40])), "bytes written to the device path");
fs.unlinkSync(devFile);

console.log("\n[3] HTTP endpoint");
const app = express();
app.use(express.json());
app.use("/print", createPrintRouter({ key: "k1", allowedOrigins: new Set(["https://kitchens.example"]), agentId: "DEV-1" }));
const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/print`;
const headers = { "Content-Type": "application/json", Origin: "https://kitchens.example", "X-Print-Key": "k1" };

const pre = await fetch(`${base}/job`, { method: "OPTIONS", headers: { Origin: "https://kitchens.example", "Access-Control-Request-Private-Network": "true" } });
ok(pre.status === 204 && pre.headers.get("access-control-allow-private-network") === "true", "answers the Private Network Access preflight");
ok((await fetch(`${base}/health`, { headers: { ...headers, "X-Print-Key": "nope" } })).status === 401, "wrong key rejected");
ok((await fetch(`${base}/health`, { headers: { ...headers, Origin: "https://evil.example" } })).status === 403, "foreign origin rejected");
const health = await (await fetch(`${base}/health`, { headers })).json();
ok(health.ok && health.agentId === "DEV-1", "health reports the agent");

const before = received.length;
const res = await fetch(`${base}/job`, { method: "POST", headers, body: JSON.stringify({ printer: lanPrinter, job: { payload: { kind: "KOT", ticket }, copies: 2 } }) });
ok(res.ok, "job accepted");
const bytes = received.at(-1);
ok(received.length === before + 1 && bytes[0] === 0x1b && bytes[1] === 0x40, "printer receives an initialised job");
ok(bytes.includes(Buffer.from([0x1b, 0x74, 19])), "code page CP858 selected");
ok(bytes.includes(Buffer.from("KOT #7")), "KOT text rendered");
ok(bytes.toString("latin1").split("\x1d\x56\x01").length - 1 === 2, "two copies, each cut");
const bad = await fetch(`${base}/job`, { method: "POST", headers, body: JSON.stringify({ printer: { ...lanPrinter, port: 1 }, job: { payload: { kind: "DRAWER" } } }) });
ok(bad.status === 502, "delivery failure surfaces as 502");

console.log("\n[4] Pull loop");
const reports = [];
const queue = [
  { id: "j1", payload: { kind: "BILL", bill: null }, copies: 1, openDrawer: true, printer: lanPrinter },
  { id: "j2", payload: { kind: "DRAWER" }, copies: 1, openDrawer: true, printer: { ...lanPrinter, port: 1 } },
];
queue[0].payload.bill = {
  brandName: "Stello", outletName: "Kor", address: null, gstin: null, fssaiNumber: null, headerLines: [], billNumber: "B-1",
  provisional: false, orderType: "TAKEAWAY", tableName: null, customerName: null, customerPhone: null, cashierName: null,
  createdAt: new Date().toISOString(), items: [], subtotal: 0, discounts: [], serviceCharge: null, taxableValue: 0,
  taxLines: [], taxTotal: 0, roundOff: null, total: 0, payments: [{ mode: "CASH", amount: 0 }], upiQr: null, footerLines: [], reprint: false,
};
const api = async (p, init) => {
  if (p.endsWith("/claim")) {
    const body = JSON.parse(init.body);
    ok(body.connections.join() === "NETWORK,USB" && body.agentId === "DEV-1", "claims NETWORK/USB jobs as this agent");
    return queue.splice(0);
  }
  reports.push({ p, body: JSON.parse(init.body) });
  return {};
};
const loop = startPullLoop({ api, outletId: () => "o1", agentId: "DEV-1", intervalMs: 60_000, log: { warn: () => {} } });
const n = received.length;
await loop.tick();
loop.stop();
ok(received.length === n + 1 && received.at(-1).includes(Buffer.from([0x1b, 0x70, 0x00, 50, 100])), "bill printed with a drawer kick");
ok(reports.find((r) => r.p === "/edge/device/print-jobs/j1/complete")?.body.ok === true, "success reported");
const failed = reports.find((r) => r.p === "/edge/device/print-jobs/j2/complete")?.body;
ok(failed && failed.ok === false && failed.error, "failure reported with the error");

server.close();
printer.close();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll print agent checks passed");
process.exit(failures ? 1 : 0);
