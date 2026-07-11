import { expect, it } from "vitest";
import { PrismaService } from "../src/prisma/prisma.service";
import { MenuAdminService } from "../src/menu/menu-admin.service";
import { RealtimeGateway } from "../src/realtime/realtime.gateway";
import { JwtService } from "@nestjs/jwt";
import { testPrisma } from "./db";

it("applies the starter template into the outlet's menu", async () => {
  const t = await testPrisma.tenant.create({ data: { name: "T" } });
  const b = await testPrisma.brand.create({ data: { tenantId: t.id, name: "B" } });
  const o = await testPrisma.outlet.create({ data: { tenantId: t.id, brandId: b.id, name: "O" } });
  const prisma = new PrismaService();
  // MenuAdminService ctor is (prisma, realtime, combos). applyStarterTemplate
  // uses only prisma + realtime, so combos can be null here.
  const svc = new MenuAdminService(prisma, new RealtimeGateway(new JwtService({ secret: "t" }), prisma), null as never);
  const user = { id: "u", tenantId: t.id, email: "e", name: "n", roleName: "Owner", permissions: ["*"], outletIds: [o.id], isPlatformAdmin: false } as any;

  const res = await svc.applyStarterTemplate(user, o.id);
  expect(res.categoriesCreated).toBeGreaterThanOrEqual(3);
  expect(res.itemsCreated).toBeGreaterThanOrEqual(8);

  const cats = await testPrisma.menuCategory.findMany({ where: { outletId: o.id }, include: { items: true } });
  expect(cats.length).toBe(res.categoriesCreated);
  const items = cats.flatMap((c) => c.items);
  expect(items.length).toBe(res.itemsCreated);
  expect(items.every((i) => i.tenantId === t.id && i.outletId === o.id)).toBe(true);
});
