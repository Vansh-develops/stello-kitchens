// Acceptance test for P2-3: synced-order idempotency via the unique constraint.
// Re-delivering the same (deviceId, clientId) — sequentially OR concurrently — must
// produce exactly one internal order, one bill number, and one stock depletion, and
// the redundant delivery must be reported as a duplicate, never an error.
import { PrismaClient } from "@prisma/client";

const API = "http://localhost:3001/api/v1";
const prisma = new PrismaClient();
let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const call = (m, p, b, tok) => fetch(`${API}${p}`, { method: m, headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: b ? JSON.stringify(b) : undefined });

async function main() {
  const token = (await j(await call("POST", "/auth/login", { email: "admin@demo.com", password: "password123" }))).accessToken;
  const outlet = await prisma.outlet.findFirstOrThrow({ where: { name: { contains: "Koramangala" } } });
  const menu = await j(await call("GET", `/outlets/${outlet.id}/menu`, null, token));
  const c65 = menu.flatMap((c) => c.items).find((i) => i.name === "Chicken 65");
  const total = Math.round(290 * 1.05 * 100) / 100;
  const ts = Date.now();

  const mkPush = (deviceId, clientId) => ({
    outletId: outlet.id, deviceId,
    orders: [{ clientId, orderType: "TAKEAWAY", items: [{ itemId: c65.id, quantity: 1 }], payments: [{ mode: "CASH", amount: total }], status: "SETTLED", offlineRef: "D-1", clientUpdatedAt: new Date().toISOString(), clientVersion: 1 }],
  });
  // Sum all raw-material stock for the outlet — the recipe depletes some subset;
  // comparing the total delta of a duplicate vs. a single order proves "once".
  const totalStock = async () => (await prisma.rawMaterial.findMany({ where: { outletId: outlet.id } })).reduce((s, m) => s + Number(m.stockQty), 0);
  const billCounter = async () => (await prisma.outlet.findUniqueOrThrow({ where: { id: outlet.id } })).nextBillNumber;

  console.log("[1] Concurrent duplicate delivery → exactly one order");
  const dev1 = `SYNC-CC-${ts}`, cid1 = `cc-${ts}`;
  const stockBefore = await totalStock();
  const billBefore = await billCounter();
  const [r1, r2] = await Promise.all([
    call("POST", "/sync/push", mkPush(dev1, cid1), token),
    call("POST", "/sync/push", mkPush(dev1, cid1), token),
  ]);
  ok(r1.status < 500 && r2.status < 500, `neither request errored at the HTTP layer (${r1.status}/${r2.status})`);
  const res1 = (await j(r1)).results?.[0], res2 = (await j(r2)).results?.[0];
  const statuses = [res1?.status, res2?.status].sort();
  ok(statuses[0] === "applied" && statuses[1] === "duplicate", `one applied + one duplicate (got ${statuses.join("/")}), never "error"`);
  ok(res1.serverId === res2.serverId && res1.billNumber === res2.billNumber, "both deliveries report the same serverId and billNumber");

  const orders = await prisma.order.findMany({ where: { deviceId: dev1, clientId: cid1 } });
  ok(orders.length === 1, `exactly one internal order exists for (deviceId, clientId) (${orders.length})`);
  ok((await billCounter()) === billBefore + 1, "the outlet bill counter advanced by exactly 1 (no wasted/duplicate number)");
  const dupDelta = stockBefore - (await totalStock());
  // Control: a single, distinct order — its depletion is one order's worth.
  const stockMid = await totalStock();
  await call("POST", "/sync/push", mkPush(`SYNC-CTL-${ts}`, `ctl-${ts}`), token);
  const singleDelta = stockMid - (await totalStock());
  ok(dupDelta > 0 && Math.abs(dupDelta - singleDelta) < 1e-9, `duplicate depleted stock once, not twice (dup ${dupDelta.toFixed(3)} === single ${singleDelta.toFixed(3)})`);

  console.log("\n[2] Sequential re-delivery (retry) → duplicate, idempotent");
  const dev2 = `SYNC-SEQ-${ts}`, cid2 = `seq-${ts}`;
  const first = (await j(await call("POST", "/sync/push", mkPush(dev2, cid2), token))).results[0];
  const second = (await j(await call("POST", "/sync/push", mkPush(dev2, cid2), token))).results[0];
  ok(first.status === "applied" && second.status === "duplicate", `first applied, retry duplicate (${first.status}/${second.status})`);
  ok(second.serverId === first.serverId && second.billNumber === first.billNumber, "retry returns the original serverId + billNumber");
  ok((await prisma.order.count({ where: { deviceId: dev2, clientId: cid2 } })) === 1, "retry did not create a second order");

  console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("SMOKE ERROR:", e); await prisma.$disconnect(); process.exit(1); });
