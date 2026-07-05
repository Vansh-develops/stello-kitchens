// Acceptance test for P0-3: a single authoritative GST invoice series per outlet.
// One online settlement + two offline devices must produce consecutive B-<n>
// numbers from one counter, and no invoice number is ever a truncated order id.
import { PrismaClient } from "@prisma/client";

const API = "http://localhost:3001/api/v1";
const prisma = new PrismaClient();
let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const j = async (r) => { const t = await r.text(); return t ? JSON.parse(t) : null; };
const call = (m, p, b, tok) => fetch(`${API}${p}`, { method: m, headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: b ? JSON.stringify(b) : undefined });

async function main() {
  const token = (await j(await call("POST", "/auth/login", { email: "admin@demo.com", password: "password123" }))).accessToken;
  const outlet = await prisma.outlet.findFirstOrThrow({ where: { name: { contains: "Koramangala" } } });
  const menu = await j(await call("GET", `/outlets/${outlet.id}/menu`, null, token));
  const c65 = menu.flatMap((c) => c.items).find((i) => i.name === "Chicken 65");
  const base = (await prisma.outlet.findUniqueOrThrow({ where: { id: outlet.id } })).nextBillNumber;
  const total = Math.round(290 * 1.05 * 100) / 100;
  const ts = Date.now();

  // 1. Online settlement → next number in the outlet series.
  console.log("\n[1] Mixed online + offline series");
  const o1 = await j(await call("POST", "/orders", { outletId: outlet.id, orderType: "TAKEAWAY", items: [{ itemId: c65.id, quantity: 1 }] }, token));
  const s1 = await j(await call("POST", `/orders/${o1.id}/settle`, { payments: [{ mode: "CARD", amount: total }] }, token));

  // 2. Two offline devices push settled orders → server assigns the next numbers.
  const pushDevice = async (deviceId, clientId, ref) =>
    (await j(await call("POST", "/sync/push", {
      outletId: outlet.id, deviceId,
      orders: [{ clientId, orderType: "TAKEAWAY", items: [{ itemId: c65.id, quantity: 1 }], payments: [{ mode: "CASH", amount: total }], status: "SETTLED", offlineRef: ref, clientUpdatedAt: new Date().toISOString(), clientVersion: 1 }],
    }, token))).results[0];
  const d1 = await pushDevice("EDGE-D1", `d1-${ts}`, "D1-1");
  const d2 = await pushDevice("EDGE-D2", `d2-${ts}`, "D2-1");

  const series = [s1.billNumber, d1.billNumber, d2.billNumber];
  ok(series.every((n) => /^B-\d+$/.test(n)), `all three are B-<n> tax numbers: ${series.join(", ")}`);
  ok(new Set(series).size === 3, "no duplicate invoice numbers across online + both devices");
  ok(series[0] === `B-${base}` && series[1] === `B-${base + 1}` && series[2] === `B-${base + 2}`, `consecutive from the single counter — no gaps (base ${base})`);

  // 3. Device provisional refs are NOT the invoice numbers.
  console.log("\n[2] Provisional refs kept separate");
  ok(!series.includes("D1-1") && !series.includes("D2-1"), "no device offlineRef leaked into the invoice series");
  const d1order = await prisma.order.findFirstOrThrow({ where: { deviceId: "EDGE-D1", clientId: `d1-${ts}` } });
  ok(d1order.offlineRef === "D1-1" && d1order.billNumber === d1.billNumber, "synced order stores offlineRef separately from its authoritative billNumber");

  // 4. Invoice numbers never come from a truncated id.
  console.log("\n[3] No slice-derived invoice numbers");
  const irn = await j(await call("POST", `/outlets/${outlet.id}/invoices/${o1.id}/irn`, {}, token));
  ok(irn.invoiceNumber === s1.billNumber && /^B-\d+$/.test(irn.invoiceNumber), `IRN invoice number is the bill number (${irn.invoiceNumber}), not an id slice`);
  ok(irn.invoiceNumber !== o1.id.slice(-6), "invoice number is not the order-id slice");

  // 5. An unsettled order cannot be invoiced.
  console.log("\n[4] Unsettled orders are not invoiceable");
  const open = await j(await call("POST", "/orders", { outletId: outlet.id, orderType: "TAKEAWAY", items: [{ itemId: c65.id, quantity: 1 }] }, token));
  const bad = await call("POST", `/outlets/${outlet.id}/invoices/${open.id}/irn`, {}, token);
  ok(bad.status >= 400, `generating an invoice for an OPEN order is rejected (${bad.status})`);
  await call("POST", `/orders/${open.id}/cancel`, null, token);

  console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("SMOKE ERROR:", e); await prisma.$disconnect(); process.exit(1); });
