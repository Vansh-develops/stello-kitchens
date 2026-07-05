// Acceptance test for P1-3: money computed in integer paise, server and edge
// formulas identical. The SAME order priced by the offline edge engine and by the
// cloud API must agree to the paisa — for a plain order and a discounted one — and
// the shared paise formula must return exact values.
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { EdgeEngine } = require("./sidecar/engine.js");
const { computeOrderTotals, toPaise, fromPaise } = require("@petpooja/shared");

const API = "http://localhost:3001/api/v1";
let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const call = (m, p, b, tok) => fetch(`${API}${p}`, { method: m, headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: b ? JSON.stringify(b) : undefined });
const money = (t) => ({ subtotal: t.subtotal, taxAmount: t.taxAmount, total: t.total });
const eq = (a, b) => a.subtotal === b.subtotal && a.taxAmount === b.taxAmount && a.total === b.total;

async function main() {
  const token = (await j(await call("POST", "/auth/login", { email: "admin@demo.com", password: "password123" }))).accessToken;
  const outlets = await j(await call("GET", "/outlets", null, token));
  const outlet = outlets.find((o) => o.name.includes("Koramangala"));
  const snapshot = await j(await call("GET", `/sync/snapshot?outletId=${outlet.id}`, null, token));

  const engine = new EdgeEngine({ dataDir: mkdtempSync(join(tmpdir(), "edge-parity-")), apiUrl: API });
  engine.cacheSnapshot(snapshot);

  // Pick several simple items (no variation/addon) so multi-line summation — the
  // float-drift-prone part — is genuinely exercised; prefer distinct tax rates.
  const flat = snapshot.menu.flatMap((c) => c.items).filter((i) => i.inStock !== false && (!i.variations || i.variations.length === 0));
  const byRate = new Map();
  for (const i of flat) if (!byRate.has(i.taxRate)) byRate.set(i.taxRate, i);
  const chosen = [...byRate.values()]; // one per distinct rate
  for (const i of flat) { if (chosen.length >= 4) break; if (!chosen.includes(i)) chosen.push(i); } // top up to 4 lines
  const items = chosen.slice(0, 4).map((it, idx) => ({ itemId: it.id, quantity: idx + 2 })); // qty 2,3,4,5

  console.log(`[1] Plain order parity (${items.length} lines, rates ${chosen.map((c) => c.taxRate).join("/")})`);
  const edgeOrder = engine.createOrder({ orderType: "TAKEAWAY", items });
  const srvId = (await j(await call("POST", "/orders", { outletId: outlet.id, orderType: "TAKEAWAY", items }, token))).id;
  const srvOrder = await j(await call("GET", `/orders/${srvId}`, null, token));
  ok(eq(money(edgeOrder), money(srvOrder)), `edge ${JSON.stringify(money(edgeOrder))} === server ${JSON.stringify(money(srvOrder))}`);

  console.log("\n[2] Discounted order parity (discount applied before tax)");
  const discount = 37.5; // deliberately not a whole rupee
  const edgeSettled = engine.settleOrder(edgeOrder.clientId, { payments: [{ mode: "CASH", amount: engine._totals(edgeOrder.lines, discount).total }], discountAmount: discount });
  const srvSettled = await j(await call("POST", `/orders/${srvId}/settle`, { payments: [{ mode: "CASH", amount: edgeSettled.total }], discountAmount: discount }, token));
  ok(eq(money(edgeSettled), money(srvSettled)), `edge ${JSON.stringify(money(edgeSettled))} === server ${JSON.stringify(money(srvSettled))}`);
  ok(srvSettled.status === "SETTLED", "server accepted the edge-computed total (proves totals matched)");

  console.log("\n[3] Shared paise formula is exact");
  const t1 = computeOrderTotals([{ lineTotalPaise: toPaise(290), taxRatePercent: 5 }], 0);
  ok(t1.subtotal === 290 && t1.taxAmount === 14.5 && t1.total === 304.5, `₹290 @5% → ${JSON.stringify(t1)}`);
  // Ten lines of ₹0.10 sum to exactly ₹1.00 in paise (naive float sum drifts to 1.0000000000000002).
  const t2 = computeOrderTotals(Array.from({ length: 10 }, () => ({ lineTotalPaise: toPaise(0.1), taxRatePercent: 0 })), 0);
  ok(t2.subtotal === 1 && t2.total === 1, `10×₹0.10 → subtotal ${t2.subtotal}, total ${t2.total} (no float drift)`);
  // Proportional discount + tax stays exact.
  const t3 = computeOrderTotals([{ lineTotalPaise: toPaise(100), taxRatePercent: 18 }, { lineTotalPaise: toPaise(50), taxRatePercent: 12 }], 30);
  const taxable = 150 - 30, scale = taxable / 150;
  const expectTax = Math.round((100 * 18 / 100 + 50 * 12 / 100) * scale * 100) / 100;
  ok(t3.subtotal === 150 && t3.discountAmount === 30 && t3.taxAmount === expectTax && t3.total === Math.round((taxable + expectTax) * 100) / 100, `mixed-rate + ₹30 discount → ${JSON.stringify(t3)}`);
  ok(fromPaise(toPaise(19.99)) === 19.99 && toPaise(0.1) === 10, "toPaise/fromPaise round-trip exactly");

  console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("SMOKE ERROR:", e); process.exit(1); });
