// Smoke test for the custom report builder: dimensions × metrics + consistency.
import { PrismaClient } from "@prisma/client";

const API = "http://localhost:3001/api/v1";
const prisma = new PrismaClient();
let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

const j = async (r) => { const t = await r.text(); return t ? JSON.parse(t) : null; };
const post = (p, body, tok) =>
  fetch(`${API}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

const dstr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function main() {
  const login = await j(await post(`/auth/login`, { email: "admin@demo.com", password: "password123" }));
  const token = login.accessToken;
  const outlet = await prisma.outlet.findFirstOrThrow({ where: { name: { contains: "Koramangala" } } });
  const to = new Date();
  const from = new Date(); from.setDate(from.getDate() - 30);
  const range = { from: dstr(from), to: dstr(to) };
  const run = async (dimension, metric) => j(await post(`/outlets/${outlet.id}/reports/custom`, { ...range, dimension, metric }, token));

  // 1. Item × revenue.
  console.log("\n[1] Item × revenue");
  const itemRev = await run("item", "revenue");
  ok(itemRev.unit === "currency" && itemRev.rows.length > 0, `${itemRev.rows.length} items, total ₹${itemRev.total}`);
  ok(itemRev.rows.every((r, i) => i === 0 || itemRev.rows[i - 1].value >= r.value), "rows sorted by value desc");
  const shareSum = itemRev.rows.reduce((s, r) => s + r.share, 0);
  ok(Math.abs(shareSum - 1) < 0.01, `shares sum to 1 (${shareSum.toFixed(3)})`);
  ok(Math.abs(itemRev.rows.reduce((s, r) => s + r.value, 0) - itemRev.total) < 1, "row values sum to the total");

  // Cross-check against the DB: total item revenue = sum of settled order-item lineTotals.
  const settled = await prisma.order.findMany({
    where: { outletId: outlet.id, status: "SETTLED", createdAt: { gte: new Date(range.from + "T00:00:00"), lte: new Date(range.to + "T23:59:59.999") } },
    select: { items: { select: { lineTotal: true } } },
  });
  const dbItemRev = Math.round(settled.flatMap((o) => o.items).reduce((s, i) => s + Number(i.lineTotal), 0) * 100) / 100;
  ok(Math.abs(itemRev.total - dbItemRev) < 1, `item revenue total matches DB (₹${itemRev.total} ≈ ₹${dbItemRev})`);

  // 2. Order type × orders (count).
  console.log("\n[2] Order type × orders");
  const typeOrders = await run("orderType", "orders");
  ok(typeOrders.unit === "count" && typeOrders.rows.length > 0, `${typeOrders.rows.length} order types`);
  ok(typeOrders.total === settled.length, `total order count matches settled orders (${typeOrders.total} = ${settled.length})`);

  // 3. Payment mode × revenue.
  console.log("\n[3] Payment mode × revenue");
  const payRev = await run("paymentMode", "revenue");
  ok(payRev.rows.length > 0 && payRev.total > 0, `payment split across ${payRev.rows.length} mode(s), ₹${payRev.total}`);

  // 4. Hour × quantity (chronological).
  console.log("\n[4] Hour × quantity");
  const hourQty = await run("hour", "quantity");
  ok(hourQty.unit === "count", "quantity metric is a count");
  ok(hourQty.rows.every((r, i) => i === 0 || hourQty.rows[i - 1].key <= r.key), "hour rows sorted chronologically");

  // 5. Category × revenue.
  console.log("\n[5] Category × revenue");
  const catRev = await run("category", "revenue");
  ok(catRev.rows.length > 0, `${catRev.rows.length} categories`);
  ok(Math.abs(catRev.total - itemRev.total) < 1, "category revenue total equals item revenue total (same sales, regrouped)");

  console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("SMOKE ERROR:", e); await prisma.$disconnect(); process.exit(1); });
