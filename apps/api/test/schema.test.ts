import { expect, it } from "vitest";
import { testPrisma } from "./db";

it("stores tenant lifecycle + platform-admin fields", async () => {
  const tenant = await testPrisma.tenant.create({
    data: { name: "T", status: "TRIAL", createdVia: "ADMIN", trialEndsAt: new Date() },
  });
  expect(tenant.status).toBe("TRIAL");
  expect(tenant.onboardedAt).toBeNull();

  const role = await testPrisma.role.create({
    data: { tenantId: tenant.id, name: "Owner", permissions: ["*"] },
  });
  const user = await testPrisma.user.create({
    data: {
      tenantId: tenant.id, email: "a@b.com", passwordHash: "x", name: "A",
      roleId: role.id, isPlatformAdmin: true, emailVerified: true,
    },
  });
  expect(user.isPlatformAdmin).toBe(true);
});
