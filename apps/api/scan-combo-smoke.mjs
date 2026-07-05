// Smoke test: a diner submits a COMBO via Scan & Order, staff validates it, and
// accepting explodes the combo into KOT components + inventory (the full loop).
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
  const outlet = await prisma.outlet.findFirstOrThrow({ where: { name: { contains: "Koramangala" } } });
  const table = await prisma.diningTable.findFirstOrThrow({ where: { outletId: outlet.id, name: "T5" } });
  const token = table.publicToken;

  // 1. Diner sees combos in the public menu.
  console.log("\n[1] Combos in the diner menu");
  const menu = await get(`/public/scan/t/${token}`);
  const combos = menu.categories.flatMap((c) => c.combos ?? []);
  const combo = combos.find((c) => c.name === "Chicken Lover's Meal");
  ok(!!combo && combo.slots.length === 3, `diner menu carries the combo with ${combo?.slots.length} slots`);

  // 2. Diner submits a combo with upgraded picks.
  console.log("\n[2] Submit a combo request");
  const mainSlot = combo.slots.find((s) => s.name === "Main");
  const drinkSlot = combo.slots.find((s) => s.name === "Drink");
  const pick = (slot, name) => ({ slotId: slot.id, itemId: slot.options.find((o) => o.name === name).itemId });
  const submit = await j(
    await post(`/public/scan/t/${token}/order`, {
      combos: [{
        comboId: combo.id,
        quantity: 1,
        selections: [pick(mainSlot, "Butter Chicken"), pick(drinkSlot, "Sweet Lassi")],
      }],
      customerName: "Combo Cathy",
    }),
  );
  ok(!!submit?.requestToken, "combo-only submission accepted (no à la carte items)");

  // 3. Staff queue shows the combo as a priced line.
  console.log("\n[3] Staff validation queue");
  const login = await j(await post(`/auth/login`, { email: "admin@demo.com", password: "password123" }));
  const staff = login.accessToken;
  const queue = await get(`/outlets/${outlet.id}/scan-requests`, staff);
  const mine = queue.find((r) => r.customerName === "Combo Cathy");
  ok(!!mine, "combo request appears in the pending queue");
  const comboLine = mine?.items.find((i) => i.name.startsWith("Combo · Chicken Lover"));
  ok(!!comboLine, "combo renders as a line with its name");
  ok(comboLine?.addonNames.includes("Butter Chicken") && comboLine?.addonNames.includes("Sweet Lassi"), "chosen components shown on the line");
  ok(mine?.total === 549, `priced at ₹549 (499 + Butter Chicken 20 + Sweet Lassi 30) → got ₹${mine?.total}`);

  // 4. Accept → real order with an exploded combo + inventory deduction.
  console.log("\n[4] Accept → explosion + inventory");
  const baseBefore = await stockOf(outlet.id, "Makhani Gravy Base");
  const chickenBefore = await stockOf(outlet.id, "Chicken");
  const accepted = await j(await post(`/outlets/${outlet.id}/scan-requests/${mine.id}/accept`, null, staff));
  ok(accepted?.status === "ACCEPTED" && typeof accepted.tokenNumber === "number", `accepted with token #${accepted?.tokenNumber}`);

  const openOrders = await get(`/orders?outletId=${outlet.id}`, staff);
  const order = openOrders.find((o) => o.tableName === "T5");
  const parent = order?.items.find((i) => i.comboName === "Chicken Lover's Meal");
  ok(!!parent && parent.unitPrice === 549, `order has the priced combo parent (₹${parent?.unitPrice})`);
  const comps = order?.items.filter((i) => i.isComboComponent) ?? [];
  ok(comps.some((c) => c.itemName === "Butter Chicken") && comps.some((c) => c.itemName === "Sweet Lassi"), "components exploded to the kitchen");
  ok(comps.every((c) => c.kotNumber != null), "components fired to a KOT");

  // Butter Chicken draws the semi-finished gravy base → multi-stage deduction through a combo.
  const baseAfter = await stockOf(outlet.id, "Makhani Gravy Base");
  const chickenAfter = await stockOf(outlet.id, "Chicken");
  ok(near(baseBefore - baseAfter, 0.15), `Butter Chicken (in the combo) drew 0.15 L gravy base → ${baseBefore}→${baseAfter}`);
  ok(near(chickenBefore - chickenAfter, 0.25), `and 0.25kg chicken`);

  // 5. Diner polls → ACCEPTED with the token.
  const polled = await get(`/public/scan/request/${submit.requestToken}`);
  ok(polled?.status === "ACCEPTED" && polled.tokenNumber === accepted.tokenNumber, "diner poll shows ACCEPTED + token");

  console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("SMOKE ERROR:", e); await prisma.$disconnect(); process.exit(1); });
