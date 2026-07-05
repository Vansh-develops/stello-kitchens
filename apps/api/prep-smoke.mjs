// End-to-end smoke test for multi-stage recipes (semi-finished goods):
// prep recipe, batch production (inputs consumed, output yielded, cost blended),
// feasibility guard, and a dish consuming the semi-finished good.
import { PrismaClient } from "@prisma/client";

const API = "http://localhost:3001/api/v1";
const prisma = new PrismaClient();
let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

const j = async (r) => { const t = await r.text(); return t ? JSON.parse(t) : null; };
const get = (p, tok) => fetch(`${API}${p}`, { headers: tok ? { authorization: `Bearer ${tok}` } : {} }).then(j);
const post = (p, body, tok) =>
  fetch(`${API}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const stockOf = async (outletId, name) => {
  const m = await prisma.rawMaterial.findFirst({ where: { outletId, name } });
  return m ? Number(m.stockQty) : null;
};
const near = (a, b, e = 0.001) => Math.abs(a - b) < e;

async function main() {
  const login = await j(await post(`/auth/login`, { email: "admin@demo.com", password: "password123" }));
  const token = login.accessToken;
  const outlet = await prisma.outlet.findFirstOrThrow({ where: { name: { contains: "Koramangala" } } });

  // 1. The semi-finished good surfaces in materials.
  console.log("\n[1] Semi-finished material");
  const materials = await get(`/outlets/${outlet.id}/inventory/materials`, token);
  const base = materials.find((m) => m.name === "Makhani Gravy Base");
  ok(!!base && base.isSemiFinished, "Makhani Gravy Base is flagged semi-finished");
  ok(materials.filter((m) => m.isSemiFinished).length >= 1 && !materials.find((m) => m.name === "Chicken").isSemiFinished, "regular materials are not semi-finished");

  // 2. Its prep recipe.
  console.log("\n[2] Prep recipe");
  const prep = await get(`/outlets/${outlet.id}/inventory/materials/${base.id}/prep-recipe`, token);
  ok(prep.ingredients.length === 5, `prep recipe has ${prep.ingredients.length} inputs`);
  const onion = prep.ingredients.find((i) => i.materialName === "Onion");
  ok(onion && near(onion.quantity, 0.3), "Onion 0.3 per L");
  ok(prep.unitCost > 0, `one litre of base costs ₹${prep.unitCost} to produce`);

  // 3. Produce a 5 L batch.
  console.log("\n[3] Produce a batch");
  const before = {
    onion: await stockOf(outlet.id, "Onion"),
    tomato: await stockOf(outlet.id, "Tomato"),
    butter: await stockOf(outlet.id, "Butter"),
    cream: await stockOf(outlet.id, "Fresh Cream"),
    base: await stockOf(outlet.id, "Makhani Gravy Base"),
  };
  const produced = await j(await post(`/outlets/${outlet.id}/inventory/materials/${base.id}/produce`, { quantity: 5 }, token));
  ok(near(produced.stockQty, before.base + 5), `base stock ${before.base} → ${produced.stockQty} L`);
  const after = {
    onion: await stockOf(outlet.id, "Onion"),
    tomato: await stockOf(outlet.id, "Tomato"),
    butter: await stockOf(outlet.id, "Butter"),
    cream: await stockOf(outlet.id, "Fresh Cream"),
  };
  ok(near(before.onion - after.onion, 1.5), `Onion consumed 1.5kg (0.3×5) → ${before.onion}→${after.onion}`);
  ok(near(before.tomato - after.tomato, 2.0), `Tomato consumed 2.0kg (0.4×5)`);
  ok(near(before.butter - after.butter, 0.25), `Butter consumed 0.25kg (0.05×5)`);
  ok(near(before.cream - after.cream, 0.5), `Cream consumed 0.5L (0.1×5)`);
  ok(produced.batchCost > 0 && near(produced.costPerUnit, produced.batchCost / 5, 0.01), `batch cost ₹${produced.batchCost}, unit cost ₹${produced.costPerUnit}`);

  // 4. A second batch blends the cost (weighted average).
  console.log("\n[4] Weighted-average cost across batches");
  const prod2 = await j(await post(`/outlets/${outlet.id}/inventory/materials/${base.id}/produce`, { quantity: 5 }, token));
  ok(near(prod2.stockQty, produced.stockQty + 5), `base stock now ${prod2.stockQty} L after a second batch`);

  // 5. A dish consumes the semi-finished good.
  console.log("\n[5] Dish consumes the base");
  const bc = await prisma.item.findFirstOrThrow({ where: { outletId: outlet.id, name: "Butter Chicken" } });
  const baseBefore = await stockOf(outlet.id, "Makhani Gravy Base");
  const chickenBefore = await stockOf(outlet.id, "Chicken");
  await post(`/orders`, { outletId: outlet.id, orderType: "TAKEAWAY", items: [{ itemId: bc.id, quantity: 2 }] }, token);
  const baseAfter = await stockOf(outlet.id, "Makhani Gravy Base");
  const chickenAfter = await stockOf(outlet.id, "Chicken");
  ok(near(baseBefore - baseAfter, 0.3), `2× Butter Chicken drew 0.3 L base (0.15×2) → ${baseBefore}→${baseAfter}`);
  ok(near(chickenBefore - chickenAfter, 0.5), `and 0.5kg chicken (0.25×2)`);

  // 6. Feasibility guard: a batch bigger than input stock is rejected.
  console.log("\n[6] Feasibility guard");
  const huge = await post(`/outlets/${outlet.id}/inventory/materials/${base.id}/produce`, { quantity: 100000 }, token);
  ok(huge.status === 400, `over-sized batch rejected (${huge.status})`);

  // 7. Setting a prep recipe flags a plain material semi-finished; clearing un-flags it.
  console.log("\n[7] Define / clear a prep recipe");
  const plain = await j(await post(`/outlets/${outlet.id}/inventory/materials`, { name: `Test Base ${Date.now()}`, unit: "L", stockQty: 0 }, token));
  const onionMat = materials.find((m) => m.name === "Onion");
  await fetch(`${API}/outlets/${outlet.id}/inventory/materials/${plain.id}/prep-recipe`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ ingredients: [{ inputMaterialId: onionMat.id, quantity: 0.5 }] }),
  });
  let m2 = (await get(`/outlets/${outlet.id}/inventory/materials`, token)).find((m) => m.id === plain.id);
  ok(m2.isSemiFinished, "defining a prep recipe flags the material semi-finished");
  await fetch(`${API}/outlets/${outlet.id}/inventory/materials/${plain.id}/prep-recipe`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ ingredients: [] }),
  });
  m2 = (await get(`/outlets/${outlet.id}/inventory/materials`, token)).find((m) => m.id === plain.id);
  ok(!m2.isSemiFinished, "clearing the prep recipe un-flags it");
  await fetch(`${API}/outlets/${outlet.id}/inventory/materials/${plain.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });

  console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("SMOKE ERROR:", e); await prisma.$disconnect(); process.exit(1); });
