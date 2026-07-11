import { expect, it } from "vitest";
import { PrismaService } from "../src/prisma/prisma.service";
import { enterTenant, runUnscoped } from "../src/common/tenant-context";
import { testPrisma } from "./db";

it("runUnscoped standalone read ignores ambient tenant", async () => {
  const tenant1 = await testPrisma.tenant.create({ data: { name: "Tenant One" } });
  const tenant2 = await testPrisma.tenant.create({ data: { name: "Tenant Two" } });
  const role1 = await testPrisma.role.create({
    data: { tenantId: tenant1.id, name: "Owner", permissions: ["*"] },
  });

  // Ambient context is tenant2 for the rest of this test.
  enterTenant(tenant2.id);

  const prisma = new PrismaService();
  // A standalone (non-transaction) lazy read wrapped in runUnscoped must still
  // find role1, which belongs to tenant1 — not the ambient tenant2 context.
  const found = await runUnscoped(() => prisma.role.findFirst({ where: { id: role1.id } }));

  expect(found?.id).toBe(role1.id);
});

it("scoped reads still filter (no leak regression)", async () => {
  const tenant1 = await testPrisma.tenant.create({ data: { name: "Tenant One" } });
  const tenant2 = await testPrisma.tenant.create({ data: { name: "Tenant Two" } });
  const role1 = await testPrisma.role.create({
    data: { tenantId: tenant1.id, name: "Owner", permissions: ["*"] },
  });
  await testPrisma.role.create({
    data: { tenantId: tenant2.id, name: "Owner", permissions: ["*"] },
  });

  enterTenant(tenant1.id);

  const prisma = new PrismaService();
  // No runUnscoped() here — the tenant-scope extension must still filter.
  const roles = await prisma.role.findMany({});

  expect(roles.length).toBeGreaterThan(0);
  expect(roles.every((r) => r.tenantId === tenant1.id)).toBe(true);
  expect(roles.some((r) => r.id === role1.id)).toBe(true);
});
