// End-to-end smoke test for Combos: menu surfacing, order explosion (priced parent
// + zero-priced kitchen components), KOT routing, inventory deduction, upgrades, 86.
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
const patch = (p, body, tok) =>
  fetch(`${API}${p}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify(body),
  });

const stockOf = async (outletId, name) => {
  const m = await prisma.rawMaterial.findFirst({ where: { outletId, name } });
  return m ? Number(m.stockQty) : null;
};

async function main() {
  const login = await j(await post(`/auth/login`, { email: "admin@demo.com", password: "password123" }));
  const token = login.accessToken;
  const outlet = await prisma.outlet.findFirstOrThrow({ where: { name: { contains: "Koramangala" } } });

  // 1. Combos surface in the menu.
  console.log("\n[1] Menu surfacing");
  const menu = await get(`/outlets/${outlet.id}/menu`, token);
  const allCombos = menu.flatMap((c) => c.combos ?? []);
  ok(allCombos.length >= 2, `menu carries ${allCombos.length} combos`);
  const chickenMeal = allCombos.find((c) => c.name === "Chicken Lover's Meal");
  ok(!!chickenMeal, "found Chicken Lover's Meal");
  ok(chickenMeal.slots.length === 3, "combo has 3 slots (Main / Drink / Dessert)");
  const mainSlot = chickenMeal.slots.find((s) => s.name === "Main");
  ok(mainSlot.options.some((o) => o.isDefault && o.name === "Chicken Biryani"), "Main defaults to Chicken Biryani");
  ok(mainSlot.options.some((o) => o.name === "Butter Chicken" && o.priceDelta === 20), "Butter Chicken upgrade +₹20");
  const mainCat = menu.find((c) => c.combos.some((x) => x.id === chickenMeal.id));
  ok(mainCat?.name === "Main Course", "combo grouped under Main Course category");

  // 2. Order the combo with default selections.
  console.log("\n[2] Order combo (defaults) → explosion + inventory");
  const riceBefore = await stockOf(outlet.id, "Basmati Rice");
  const chickenBefore = await stockOf(outlet.id, "Chicken");
  const order1 = await j(
    await post(`/orders`, { outletId: outlet.id, orderType: "TAKEAWAY", combos: [{ comboId: chickenMeal.id, quantity: 1 }] }, token),
  );
  const parent = order1.items.find((i) => i.comboName === "Chicken Lover's Meal");
  ok(!!parent && parent.unitPrice === 499, `priced parent line = ₹${parent?.unitPrice}`);
  const comps = order1.items.filter((i) => i.isComboComponent && i.comboGroupId === parent.comboGroupId);
  ok(comps.length === 3, `3 zero-priced component lines (${comps.map((c) => c.itemName).join(", ")})`);
  ok(comps.every((c) => c.unitPrice === 0), "components are ₹0 (price is in the combo line)");
  ok(comps.some((c) => c.itemName === "Chicken Biryani") && comps.some((c) => c.itemName === "Soft Drink") && comps.some((c) => c.itemName === "Gulab Jamun"), "default components: Biryani + Soft Drink + Gulab Jamun");
  ok(comps.every((c) => c.kotNumber != null), "components fired to a KOT");
  ok(parent.kotNumber == null, "combo parent line is billing-only (no KOT)");
  ok(Math.abs(order1.subtotal - 499) < 0.01, `subtotal = combo price (₹${order1.subtotal})`);
  ok(Math.abs(order1.total - 523.95) < 0.5, `total = combo + 5% tax (₹${order1.total})`);
  const riceAfter = await stockOf(outlet.id, "Basmati Rice");
  const chickenAfter = await stockOf(outlet.id, "Chicken");
  ok(Math.abs((riceBefore - riceAfter) - 0.15) < 0.001, `Basmati Rice deducted 0.15kg (${riceBefore}→${riceAfter}) via Biryani recipe`);
  ok(Math.abs((chickenBefore - chickenAfter) - 0.2) < 0.001, `Chicken deducted 0.2kg (${chickenBefore}→${chickenAfter})`);

  // 3. Order with upgraded selections.
  console.log("\n[3] Order combo (upgrades) → priced deltas + chosen components");
  const drinkSlot = chickenMeal.slots.find((s) => s.name === "Drink");
  const dessertSlot = chickenMeal.slots.find((s) => s.name === "Dessert");
  const pick = (slot, name) => ({ slotId: slot.id, itemId: slot.options.find((o) => o.name === name).itemId });
  const order2 = await j(
    await post(`/orders`, {
      outletId: outlet.id,
      orderType: "TAKEAWAY",
      combos: [{
        comboId: chickenMeal.id,
        quantity: 1,
        selections: [pick(mainSlot, "Butter Chicken"), pick(drinkSlot, "Sweet Lassi"), pick(dessertSlot, "Rasmalai")],
      }],
    }, token),
  );
  const parent2 = order2.items.find((i) => i.comboName === "Chicken Lover's Meal");
  ok(parent2.unitPrice === 569, `upgraded combo priced ₹569 (499 + 20 + 30 + 20) → got ₹${parent2.unitPrice}`);
  const comp2 = order2.items.filter((i) => i.isComboComponent);
  ok(comp2.some((c) => c.itemName === "Butter Chicken") && comp2.some((c) => c.itemName === "Sweet Lassi") && comp2.some((c) => c.itemName === "Rasmalai"), "components reflect the chosen upgrades");

  // 4. Settle → bill shows the combo total.
  console.log("\n[4] Settle");
  const settled = await j(await post(`/orders/${order2.id}/settle`, { payments: [{ mode: "CASH", amount: order2.total }] }, token));
  ok(settled.status === "SETTLED" && settled.billNumber, `settled with bill ${settled.billNumber} at ₹${settled.total}`);

  // 5. Mixed order: a combo + a regular item together.
  console.log("\n[5] Combo + à la carte in one order");
  const c65 = menu.flatMap((c) => c.items).find((i) => i.name === "Chicken 65");
  const order3 = await j(
    await post(`/orders`, {
      outletId: outlet.id,
      orderType: "TAKEAWAY",
      items: [{ itemId: c65.id, quantity: 1 }],
      combos: [{ comboId: chickenMeal.id, quantity: 1 }],
    }, token),
  );
  ok(Math.abs(order3.subtotal - (499 + 290)) < 0.01, `subtotal = combo + à la carte (₹${order3.subtotal})`);

  // 6. 86 the combo → ordering it is blocked.
  console.log("\n[6] Out-of-stock (86) a combo");
  await patch(`/outlets/${outlet.id}/combos/${chickenMeal.id}/stock`, { inStock: false }, token);
  const blocked = await post(`/orders`, { outletId: outlet.id, orderType: "TAKEAWAY", combos: [{ comboId: chickenMeal.id, quantity: 1 }] }, token);
  ok(blocked.status === 400, `ordering an 86'd combo is rejected (${blocked.status})`);
  await patch(`/outlets/${outlet.id}/combos/${chickenMeal.id}/stock`, { inStock: true }, token); // restore

  console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("SMOKE ERROR:", e); await prisma.$disconnect(); process.exit(1); });
