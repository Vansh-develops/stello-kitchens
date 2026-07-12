import { expect, it } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { PrismaService } from "../src/prisma/prisma.service";
import { OutletsController } from "../src/outlets/outlets.controller";
import { testPrisma } from "./db";

async function seedOutlet() {
  const t = await testPrisma.tenant.create({ data: { name: "T" } });
  const b = await testPrisma.brand.create({ data: { tenantId: t.id, name: "B" } });
  const o = await testPrisma.outlet.create({ data: { tenantId: t.id, brandId: b.id, name: "O" } });
  return { t, o };
}
function userFor(tenantId: string, outletIds: string[]) {
  return { id: "u", tenantId, email: "e", name: "n", roleName: "Owner", permissions: ["*"], outletIds, isPlatformAdmin: false };
}

it("updates own outlet fields", async () => {
  const { t, o } = await seedOutlet();
  const ctrl = new OutletsController(new PrismaService());
  await ctrl.update(userFor(t.id, [o.id]) as any, o.id, { address: "12 MG Rd", gstin: "29ABCDE1234F1Z5" });
  const fresh = await testPrisma.outlet.findUnique({ where: { id: o.id } });
  expect(fresh?.address).toBe("12 MG Rd");
  expect(fresh?.gstin).toBe("29ABCDE1234F1Z5");
});

it("rejects updating an outlet in another tenant (no cross-tenant write)", async () => {
  const a = await seedOutlet();
  const b = await seedOutlet();
  const ctrl = new OutletsController(new PrismaService());
  // user from tenant A claims access to A's outlet id list, but targets B's outlet id
  await expect(
    ctrl.update(userFor(a.t.id, [b.o.id]) as any, b.o.id, { name: "hacked" }),
  ).rejects.toThrow(NotFoundException);
});
