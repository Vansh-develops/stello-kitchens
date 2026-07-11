import { expect, it } from "vitest";
import { PrismaService } from "../src/prisma/prisma.service";
import { TenantController } from "../src/tenant/tenant.controller";
import { testPrisma } from "./db";

const userFor = (tenantId: string) =>
  ({ id: "u", tenantId, email: "e", name: "n", roleName: "Owner", permissions: ["*"], outletIds: [], isPlatformAdmin: false }) as any;

it("returns tenant summary and completes onboarding", async () => {
  const t = await testPrisma.tenant.create({ data: { name: "Spice Route", createdVia: "ADMIN" } });
  const ctrl = new TenantController(new PrismaService());

  const before = await ctrl.current(userFor(t.id));
  expect(before.name).toBe("Spice Route");
  expect(before.onboardedAt).toBeNull();

  const done = await ctrl.complete(userFor(t.id));
  expect(done.onboardedAt).not.toBeNull();

  const after = await ctrl.current(userFor(t.id));
  expect(after.onboardedAt).not.toBeNull();
});
