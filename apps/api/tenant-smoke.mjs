// Acceptance test for P0-1: structural tenant isolation.
// Sets up a second tenant (Rival Foods) and verifies tenant A cannot read
// tenant B's rows, while same-tenant reads keep working.
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const API = "http://localhost:3001/api/v1";
const prisma = new PrismaClient(); // NB: the test's own client is NOT tenant-scoped — used to seed B.
let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const j = async (r) => { const t = await r.text(); return t ? JSON.parse(t) : null; };
const login = async (email) => (await j(await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "password123" }) }))).accessToken;
const get = (p, tok) => fetch(`${API}${p}`, { headers: { authorization: `Bearer ${tok}` } });

async function seedTenantB() {
  let tenant = await prisma.tenant.findFirst({ where: { name: "Rival Foods" } });
  if (tenant) {
    const outlet = await prisma.outlet.findFirst({ where: { tenantId: tenant.id } });
    const order = await prisma.order.findFirst({ where: { tenantId: tenant.id } });
    return { tenant, outlet, order };
  }
  tenant = await prisma.tenant.create({ data: { name: "Rival Foods" } });
  const brand = await prisma.brand.create({ data: { tenantId: tenant.id, name: "Rival" } });
  const outlet = await prisma.outlet.create({ data: { tenantId: tenant.id, brandId: brand.id, name: "Rival - MG Road", address: "MG Road" } });
  const role = await prisma.role.create({ data: { tenantId: tenant.id, name: "Owner", permissions: ["*"] } });
  await prisma.user.create({
    data: {
      tenantId: tenant.id, email: "rival@demo.com", passwordHash: await bcrypt.hash("password123", 10),
      name: "Rival Owner", roleId: role.id, userOutlets: { create: [{ outletId: outlet.id }] },
    },
  });
  const order = await prisma.order.create({
    data: {
      tenantId: tenant.id, outletId: outlet.id, orderType: "TAKEAWAY", status: "SETTLED",
      billNumber: "R-1", subtotal: 100, taxAmount: 5, total: 105,
      items: { create: [{ itemId: "rival-item", itemName: "Rival Special", quantity: 1, unitPrice: 100, lineTotal: 100 }] },
      payments: { create: [{ mode: "CASH", amount: 105 }] },
    },
  });
  return { tenant, outlet, order };
}

async function main() {
  const b = await seedTenantB();
  const aTok = await login("admin@demo.com");   // tenant A: Demo Restaurants
  const bTok = await login("rival@demo.com");    // tenant B: Rival Foods
  const aOutlet = await prisma.outlet.findFirstOrThrow({ where: { name: { contains: "Koramangala" } } });
  const aOrder = await prisma.order.findFirstOrThrow({ where: { outletId: aOutlet.id, status: "SETTLED" } });

  // 1. Cross-tenant read by id is blocked (findUnique scoped by the extension).
  console.log("\n[1] Cross-tenant read blocked");
  const xr = await get(`/orders/${b.order.id}`, aTok);
  ok(xr.status === 404, `tenant A fetching tenant B's order → 404 (got ${xr.status})`);

  // 2. Same-tenant reads still work — no over-blocking.
  console.log("\n[2] Same-tenant reads still work");
  const own = await get(`/orders/${aOrder.id}`, aTok);
  ok(own.status === 200, `tenant A fetching its own order → 200 (got ${own.status})`);
  const bOwn = await get(`/orders/${b.order.id}`, bTok);
  ok(bOwn.status === 200, `tenant B fetching its own order → 200 (got ${bOwn.status})`);

  // 3. Tenant-scoped listings never surface another tenant's rows.
  console.log("\n[3] Cross-tenant listing isolation");
  const aOutlets = await j(await get(`/outlets`, aTok));
  ok(!aOutlets.some((o) => o.name.includes("Rival")), "tenant A's outlet list excludes Rival Foods outlets");
  const aKpis = await j(await get(`/reports/outlets`, aTok));
  ok(Array.isArray(aKpis) && !aKpis.some((k) => (k.name || k.outletName || "").includes("Rival")), "tenant A's cross-outlet KPIs exclude Rival Foods");
  const bOutlets = await j(await get(`/outlets`, bTok));
  ok(bOutlets.length === 1 && bOutlets[0].name.includes("Rival"), "tenant B sees only its own outlet");

  // 4. Public/system paths remain unscoped (login for a different tenant works).
  console.log("\n[4] Public paths unaffected");
  ok(!!bTok, "tenant B could log in (public auth path is not tenant-scoped)");

  console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("SMOKE ERROR:", e); await prisma.$disconnect(); process.exit(1); });
