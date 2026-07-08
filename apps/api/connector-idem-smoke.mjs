// Acceptance test for P0-2: atomic, idempotent aggregator ingest.
import { PrismaClient } from "@prisma/client";

const API = "http://localhost:3001/api/v1";
const KEY = process.env.CONNECTOR_KEY ?? "dev-connector-key";
const prisma = new PrismaClient();
let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const j = async (r) => { const t = await r.text(); return t ? JSON.parse(t) : null; };
const ingest = (body) => fetch(`${API}/connector/ingest`, { method: "POST", headers: { "content-type": "application/json", "x-connector-key": KEY }, body: JSON.stringify(body) });
const near = (a, b, e = 0.0005) => Math.abs(a - b) < e;

async function main() {
  const outlet = await prisma.outlet.findFirstOrThrow({ where: { name: { contains: "Koramangala" } } });
  // Find a mapped external item whose recipe consumes Chicken, so we can measure double-depletion.
  const chicken = await prisma.rawMaterial.findFirstOrThrow({ where: { outletId: outlet.id, name: "Chicken" } });
  const maps = await prisma.aggregatorMenuMap.findMany({
    where: { channel: { outletId: outlet.id } },
    include: { item: { include: { recipe: true } } },
  });
  const map = maps.find((m) => m.item.recipe.some((r) => r.rawMaterialId === chicken.id));
  if (!map) { console.log("no chicken-recipe aggregator map; skipping"); process.exit(0); }
  const chickenPerOrder = Number(map.item.recipe.find((r) => r.rawMaterialId === chicken.id).quantity);

  const ext = "Z-CONCURRENT-" + Date.now();
  const body = { platform: "ZOMATO", externalOrderId: ext, outletId: outlet.id, items: [{ externalItemId: map.externalId, quantity: 1 }], orderValue: 300 };
  const stockOf = async () => Number((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: chicken.id } })).stockQty);

  // 1. Fire the SAME order twice concurrently.
  console.log("\n[1] Concurrent duplicate delivery");
  const before = await stockOf();
  const [r1, r2] = await Promise.all([ingest(body), ingest(body)]);
  const [b1, b2] = [await j(r1), await j(r2)];
  const results = [b1, b2];
  const applied = results.filter((r) => r && r.duplicate === false && r.orderId);
  const dups = results.filter((r) => r && r.duplicate === true);
  ok(applied.length === 1, `exactly one delivery created the order (applied=${applied.length})`);
  ok(dups.length === 1, `exactly one delivery returned duplicate (dups=${dups.length})`);

  // 2. Exactly one internal order + one KOT + one depletion.
  console.log("\n[2] No double-fire");
  const aggRows = await prisma.aggregatorOrder.findMany({ where: { platform: "ZOMATO", externalOrderId: ext } });
  ok(aggRows.length === 1, `exactly one aggregatorOrder row for the external id (${aggRows.length})`);
  ok(aggRows[0].orderId && aggRows[0].status === "ACCEPTED", "the row is linked to one internal order, ACCEPTED");
  const internal = await prisma.order.findMany({ where: { id: aggRows[0].orderId }, include: { kots: true } });
  ok(internal.length === 1 && internal[0].kots.length === 1, "one internal order with one KOT");
  const after = await stockOf();
  ok(near(before - after, chickenPerOrder), `chicken deducted once, not twice (${before}→${after}, per-order ${chickenPerOrder})`);

  // 3. Sequential re-delivery (retry) is idempotent — no new order, no extra depletion.
  console.log("\n[3] Retry idempotency");
  const retry = await j(await ingest(body));
  ok(retry?.duplicate === true, "re-delivering the same order returns duplicate");
  const after2 = await stockOf();
  ok(near(after2, after), "retry did not deplete stock again");
  const aggRows2 = await prisma.aggregatorOrder.count({ where: { platform: "ZOMATO", externalOrderId: ext } });
  ok(aggRows2 === 1, "still exactly one aggregatorOrder row after the retry");

  console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("SMOKE ERROR:", e); await prisma.$disconnect(); process.exit(1); });
