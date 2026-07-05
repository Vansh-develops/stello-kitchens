// Acceptance test for P2-2: IGST for inter-state supply.
// The outlet is in state 29 (place of supply). A buyer GSTIN in a different state
// makes the supply inter-state → the whole tax is IGST and CGST/SGST are zero; a
// same-state buyer (or B2C) stays CGST + SGST. The tax total is unchanged either way.
import { PrismaClient } from "@prisma/client";

const API = "http://localhost:3001/api/v1";
const prisma = new PrismaClient();
let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const call = (m, p, b, tok) => fetch(`${API}${p}`, { method: m, headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: b ? JSON.stringify(b) : undefined });
const near = (a, b) => Math.abs(a - b) < 0.005;

async function main() {
  const token = (await j(await call("POST", "/auth/login", { email: "admin@demo.com", password: "password123" }))).accessToken;
  const outlet = await prisma.outlet.findFirstOrThrow({ where: { name: { contains: "Koramangala" } } });
  const sellerState = outlet.placeOfSupply ?? outlet.gstin.slice(0, 2);
  const menu = await j(await call("GET", `/outlets/${outlet.id}/menu`, null, token));
  const c65 = menu.flatMap((c) => c.items).find((i) => i.name === "Chicken 65");
  const total = Math.round(290 * 1.05 * 100) / 100;

  const settle = async () => {
    const o = await j(await call("POST", "/orders", { outletId: outlet.id, orderType: "TAKEAWAY", items: [{ itemId: c65.id, quantity: 1 }] }, token));
    await call("POST", `/orders/${o.id}/settle`, { payments: [{ mode: "CARD", amount: total }] }, token);
    return o.id;
  };
  const detail = async (id) => j(await call("GET", `/outlets/${outlet.id}/invoices/${id}`, null, token));

  console.log(`[1] B2C / no buyer GSTIN → intra-state (seller state ${sellerState})`);
  const idA = await settle();
  const dA = await detail(idA);
  const taxA = dA.cgst + dA.sgst + dA.igst;
  ok(dA.igst === 0 && dA.cgst > 0 && near(dA.cgst, dA.sgst), `no buyer → CGST ${dA.cgst} + SGST ${dA.sgst}, IGST 0`);

  console.log("\n[2] Inter-state buyer (state 27 ≠ 29) → full IGST, zero CGST/SGST");
  const idB = await settle();
  const dBefore = await detail(idB);
  const dB = await j(await call("POST", `/outlets/${outlet.id}/invoices/${idB}/irn`, { buyerGstin: "27ABCDE1234F1Z5" }, token));
  const taxB = dB.cgst + dB.sgst + dB.igst;
  ok(dB.cgst === 0 && dB.sgst === 0 && dB.igst > 0, `inter-state → CGST 0, SGST 0, IGST ${dB.igst}`);
  ok(near(taxB, taxA), `tax total unchanged by the split (${taxB.toFixed(2)} ≈ ${taxA.toFixed(2)})`);
  ok(near(dB.igst, dBefore.cgst + dBefore.sgst), `IGST equals the pre-IRN CGST+SGST (${dB.igst})`);
  const hsnIgst = dB.hsnSummary.reduce((s, r) => s + r.igst, 0);
  const hsnCgst = dB.hsnSummary.reduce((s, r) => s + r.cgst + r.sgst, 0);
  ok(near(hsnIgst, dB.igst) && hsnCgst === 0, `HSN rows carry IGST only (Σigst ${hsnIgst.toFixed(2)}, Σcgst+sgst ${hsnCgst})`);

  console.log("\n[3] Same-state buyer (state 29 = 29) → stays CGST + SGST");
  const idC = await settle();
  const dC = await j(await call("POST", `/outlets/${outlet.id}/invoices/${idC}/irn`, { buyerGstin: "29AAAAA1234A1Z5" }, token));
  ok(dC.igst === 0 && dC.cgst > 0 && near(dC.cgst, dC.sgst), `same-state buyer → CGST ${dC.cgst} + SGST ${dC.sgst}, IGST 0`);

  console.log("\n[4] Invoice list reflects the split");
  // Use the server's default date range (avoids UTC/local date-boundary flakiness).
  const rows = await j(await call("GET", `/outlets/${outlet.id}/invoices`, null, token));
  const rowB = rows.find((r) => r.orderId === idB);
  const rowC = rows.find((r) => r.orderId === idC);
  ok(rowB && rowB.igst > 0 && rowB.cgst === 0 && rowB.sgst === 0, "inter-state order lists as IGST");
  ok(rowC && rowC.igst === 0 && rowC.cgst > 0, "same-state order lists as CGST/SGST");

  console.log("\n[5] Stored invoice persists the correct split");
  const stored = await prisma.invoice.findUniqueOrThrow({ where: { orderId: idB } });
  ok(Number(stored.igst) > 0 && Number(stored.cgst) === 0 && Number(stored.sgst) === 0, `persisted invoice row is IGST (igst ${stored.igst})`);

  console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("SMOKE ERROR:", e); await prisma.$disconnect(); process.exit(1); });
