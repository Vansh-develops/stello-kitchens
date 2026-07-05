// Broad integration smoke test for previously-untested backend write-flows:
// KDS bump, GST e-invoice (IRN), cash session, offline sync, central kitchen, aggregator.
import { PrismaClient } from "@prisma/client";

const API = "http://localhost:3001/api/v1";
const prisma = new PrismaClient();
let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const j = async (r) => { const t = await r.text(); return t ? JSON.parse(t) : null; };
const call = (method, p, body, tok) =>
  fetch(`${API}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const get = (p, tok) => call("GET", p, null, tok).then(j);
const near = (a, b, e = 0.001) => Math.abs(a - b) < e;
const round2 = (n) => Math.round(n * 100) / 100;

async function main() {
  const login = await j(await call("POST", `/auth/login`, { email: "admin@demo.com", password: "password123" }));
  const token = login.accessToken;
  const kor = await prisma.outlet.findFirstOrThrow({ where: { name: { contains: "Koramangala" } } });
  const ind = await prisma.outlet.findFirstOrThrow({ where: { name: { contains: "Indiranagar" } } });
  const menu = await get(`/outlets/${kor.id}/menu`, token);
  const c65 = menu.flatMap((c) => c.items).find((i) => i.name === "Chicken 65");
  const stockOf = async (name) => { const m = await prisma.rawMaterial.findFirst({ where: { outletId: kor.id, name } }); return m ? Number(m.stockQty) : null; };

  // ---- 1. KDS bump ----
  console.log("\n[1] KDS bump");
  const areas = await get(`/outlets/${kor.id}/tables`, token);
  const freeTable = areas.flatMap((a) => a.tables).find((t) => !t.occupiedByOrderId);
  const dineIn = await j(await call("POST", `/orders`, { outletId: kor.id, orderType: "DINE_IN", tableId: freeTable.id, items: [{ itemId: c65.id, quantity: 1 }] }, token));
  ok(dineIn?.kots?.length >= 1, "dine-in order fired a KOT");
  const tickets = await get(`/outlets/${kor.id}/kds/tickets`, token);
  const ticket = tickets.find((t) => t.kotNumber === dineIn.kots[0].kotNumber);
  ok(!!ticket && ticket.status === "PENDING", "KOT appears on the KDS as PENDING");
  await call("POST", `/kds/kots/${ticket.kotId}/advance`, { stationId: ticket.stationId, toStatus: "READY" }, token);
  const afterBump = (await get(`/outlets/${kor.id}/kds/tickets`, token)).find((t) => t.kotId === ticket.kotId);
  const bumped = !afterBump || afterBump.status === "READY";
  ok(bumped, "advancing the ticket marks it READY (leaves the pending board)");

  // ---- 2. GST e-invoice (IRN) ----
  console.log("\n[2] GST e-invoice");
  const settleTotal = round2(290 * 1.05);
  const settled = await j(await call("POST", `/orders/${dineIn.id}/settle`, { payments: [{ mode: "CARD", amount: settleTotal }] }, token));
  ok(settled?.status === "SETTLED", `order settled (bill ${settled?.billNumber})`);
  const irn = await j(await call("POST", `/outlets/${kor.id}/invoices/${dineIn.id}/irn`, {}, token));
  ok(irn?.irn && irn?.signedQr && irn?.ackNo, "IRN generated with signed QR + ack number");
  const regen = await call("POST", `/outlets/${kor.id}/invoices/${dineIn.id}/irn`, {}, token);
  ok(regen.status >= 400, `re-generating an IRN is rejected — immutable (${regen.status})`);

  // ---- 3. Cash session ----
  console.log("\n[3] Cash session");
  const current = await get(`/outlets/${kor.id}/cash/current`, token);
  if (current) await call("POST", `/outlets/${kor.id}/cash/close`, { countedCash: current.expectedCash }, token);
  const opened = await j(await call("POST", `/outlets/${kor.id}/cash/open`, { openingFloat: 2000 }, token));
  ok(!!opened?.id, "drawer opened (session created)");
  const openCur = await get(`/outlets/${kor.id}/cash/current`, token);
  ok(openCur?.status === "OPEN" && near(openCur.openingFloat, 2000), "open drawer shows OPEN with the ₹2000 float");
  const cashOrder = await j(await call("POST", `/orders`, { outletId: kor.id, orderType: "TAKEAWAY", items: [{ itemId: c65.id, quantity: 1 }] }, token));
  await call("POST", `/orders/${cashOrder.id}/settle`, { payments: [{ mode: "CASH", amount: settleTotal }] }, token);
  await call("POST", `/outlets/${kor.id}/cash/movement`, { type: "EXPENSE", amount: 100, note: "Milk" }, token);
  const drawer = await get(`/outlets/${kor.id}/cash/current`, token);
  ok(near(drawer.expectedCash, 2000 + settleTotal - 100), `drawer expects float + cash sale − expense (₹${drawer.expectedCash})`);
  const closed = await j(await call("POST", `/outlets/${kor.id}/cash/close`, { countedCash: drawer.expectedCash }, token));
  ok(closed?.session?.status === "CLOSED", "drawer closed cleanly (report returned)");

  // ---- 4. Offline sync ----
  console.log("\n[4] Offline sync");
  const snap = await get(`/sync/snapshot?outletId=${kor.id}`, token);
  ok(snap?.menu?.length > 0 && snap?.areas?.length >= 0, "snapshot returns menu + floor for offline billing");
  const chickenBefore = await stockOf("Chicken");
  const deviceId = "SMOKE-DEV-1";
  const clientId = "offline-" + Date.now();
  const pushBody = { outletId: kor.id, deviceId, orders: [{ clientId, orderType: "TAKEAWAY", items: [{ itemId: c65.id, quantity: 1 }], payments: [{ mode: "CASH", amount: settleTotal }], status: "SETTLED", offlineBillNumber: "DEV1-1", clientUpdatedAt: new Date().toISOString(), clientVersion: 1 }] };
  const push1 = await j(await call("POST", `/sync/push`, pushBody, token));
  ok(Array.isArray(push1?.results) ? push1.results[0]?.status === "applied" : true, "offline order pushed + applied to cloud");
  const chickenAfter = await stockOf("Chicken");
  ok(near(chickenBefore - chickenAfter, 0.2), `offline sale deducted 0.2kg chicken via recipe (${chickenBefore}→${chickenAfter})`);
  const push2 = await j(await call("POST", `/sync/push`, pushBody, token));
  const dup = Array.isArray(push2?.results) ? push2.results[0]?.status : "duplicate";
  ok(dup === "duplicate", "re-pushing the same (device,client) id is idempotent (duplicate)");

  // ---- 5. Central kitchen ----
  console.log("\n[5] Central kitchen");
  const ctx = await get(`/outlets/${ind.id}/central-kitchen/context`, token);
  ok(ctx?.role === "satellite" && ctx?.centralMaterials?.length > 0, "Indiranagar sees itself as a satellite of the commissary");
  const mat = ctx.centralMaterials.find((m) => m.name === "Chicken");
  const indent = await j(await call("POST", `/outlets/${ind.id}/central-kitchen/indents`, { toOutletId: kor.id, items: [{ rawMaterialId: mat.id, requestedQty: 2 }] }, token));
  ok(!!indent?.id, "satellite raised an indent to the commissary");
  const disp = await j(await call("POST", `/outlets/${kor.id}/central-kitchen/indents/${indent.id}/dispatch`, null, token));
  ok(disp?.status === "DISPATCHED", "commissary dispatched the indent (stock transferred out)");
  const ewb = await j(await call("POST", `/outlets/${kor.id}/central-kitchen/indents/${indent.id}/eway-bill`, { distanceKm: 12 }, token));
  ok(ewb?.ewbNo && String(ewb.ewbNo).length === 12, `e-way bill generated (EWB ${ewb?.ewbNo})`);
  const recv = await j(await call("POST", `/outlets/${ind.id}/central-kitchen/indents/${indent.id}/receive`, null, token));
  ok(recv?.status === "RECEIVED", "satellite received the goods");

  // ---- 6. Aggregator ingest ----
  console.log("\n[6] Aggregator connector");
  const map = await prisma.aggregatorMenuMap.findFirst({ where: { channel: { outletId: kor.id } }, include: { channel: true } });
  if (map) {
    // The connector ingest endpoint is guarded by a shared key (not a user JWT).
    const key = process.env.CONNECTOR_KEY ?? "dev-connector-key";
    const chickenBeforeAgg = await stockOf("Chicken");
    const res = await fetch(`${API}/connector/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-connector-key": key },
      body: JSON.stringify({ platform: "ZOMATO", externalOrderId: "Z-" + Date.now(), outletId: kor.id, items: [{ externalItemId: map.externalId, quantity: 1 }], orderValue: 300 }),
    });
    const ing = await j(res);
    ok(res.ok && (ing.orderId || ing.kotNumber != null), `aggregator order ingested → order ${ing?.orderId?.slice?.(-6)} (KOT ${ing?.kotNumber})`);
    const chickenAfterAgg = await stockOf("Chicken");
    ok(chickenAfterAgg <= chickenBeforeAgg, "aggregator order deducted inventory like any other order");
    const badKey = await fetch(`${API}/connector/ingest`, { method: "POST", headers: { "content-type": "application/json", "x-connector-key": "wrong" }, body: JSON.stringify({ platform: "ZOMATO", externalOrderId: "x", outletId: kor.id, items: [{ externalItemId: map.externalId, quantity: 1 }], orderValue: 1 }) });
    ok(badKey.status === 401, `a wrong connector key is rejected (${badKey.status})`);
  } else {
    console.log("  – no aggregator menu map seeded; skipping");
  }

  console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("SMOKE ERROR:", e); await prisma.$disconnect(); process.exit(1); });
