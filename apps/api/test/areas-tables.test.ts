import { expect, it } from "vitest";
import { PrismaService } from "../src/prisma/prisma.service";
import { OnboardingController } from "../src/onboarding/onboarding.controller";
import { testPrisma } from "./db";

async function seed() {
  const t = await testPrisma.tenant.create({ data: { name: "T" } });
  const b = await testPrisma.brand.create({ data: { tenantId: t.id, name: "B" } });
  const o = await testPrisma.outlet.create({ data: { tenantId: t.id, brandId: b.id, name: "O" } });
  return { t, o };
}
const userFor = (tenantId: string, outletIds: string[]) =>
  ({ id: "u", tenantId, email: "e", name: "n", roleName: "Owner", permissions: ["*"], outletIds, isPlatformAdmin: false }) as any;

it("creates an area then tables with unique publicTokens", async () => {
  const { t, o } = await seed();
  const ctrl = new OnboardingController(new PrismaService());
  const area = await ctrl.createArea(userFor(t.id, [o.id]), o.id, { name: "Main" });
  const res = await ctrl.createTables(userFor(t.id, [o.id]), o.id, { areaId: area.id, count: 4 });
  expect(res.tables).toHaveLength(4);
  const tokens = new Set(res.tables.map((x) => x.publicToken));
  expect(tokens.size).toBe(4);
  const rows = await testPrisma.diningTable.findMany({ where: { outletId: o.id } });
  expect(rows.length).toBe(4);
  expect(rows.every((r) => r.tenantId === t.id && r.areaId === area.id)).toBe(true);
});

it("rejects creating tables under an area from another tenant", async () => {
  const a = await seed();
  const b = await seed();
  const areaB = await testPrisma.area.create({ data: { tenantId: b.t.id, outletId: b.o.id, name: "X" } });
  const ctrl = new OnboardingController(new PrismaService());
  await expect(
    ctrl.createTables(userFor(a.t.id, [a.o.id]), a.o.id, { areaId: areaB.id, count: 2 }),
  ).rejects.toThrow();
});
