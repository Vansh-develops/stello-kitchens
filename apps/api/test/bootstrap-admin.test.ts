import { expect, it } from "vitest";
import { testPrisma } from "./db";
import { promotePlatformAdmin } from "../prisma/provision-platform-admin";

it("promotes an existing user to platform admin", async () => {
  const tenant = await testPrisma.tenant.create({ data: { name: "T" } });
  const role = await testPrisma.role.create({ data: { tenantId: tenant.id, name: "Owner", permissions: ["*"] } });
  await testPrisma.user.create({
    data: { tenantId: tenant.id, email: "boss@x.com", passwordHash: "x", name: "Boss", roleId: role.id },
  });
  const ok = await promotePlatformAdmin(testPrisma, "boss@x.com");
  expect(ok).toBe(true);
  const u = await testPrisma.user.findUnique({ where: { email: "boss@x.com" } });
  expect(u?.isPlatformAdmin).toBe(true);
});

it("returns false for an unknown email", async () => {
  expect(await promotePlatformAdmin(testPrisma, "ghost@x.com")).toBe(false);
});
