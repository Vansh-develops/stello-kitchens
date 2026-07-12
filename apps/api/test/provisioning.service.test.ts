import { expect, it } from "vitest";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../src/prisma/prisma.service";
import { ProvisioningService } from "../src/provisioning/provisioning.service";
import { enterTenant } from "../src/common/tenant-context";
import { testPrisma } from "./db";

function svc() { return new ProvisioningService(new PrismaService()); }

it("creates the full tenant graph with matching tenantId and seed-parity roles", async () => {
  const prisma = new PrismaService();
  const service = new ProvisioningService(prisma);
  const { tenantId, ownerId } = await service.provisionTenant({
    restaurantName: "Spice Route", ownerName: "Asha", ownerEmail: "asha@x.com",
    ownerPassword: "secret12", createdVia: "ADMIN",
  });

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  expect(tenant?.status).toBe("TRIAL");
  expect(tenant?.createdVia).toBe("ADMIN");
  expect(tenant?.trialEndsAt).not.toBeNull();

  const roles = await prisma.role.findMany({ where: { tenantId } });
  const byName = Object.fromEntries(roles.map((r) => [r.name, r.permissions]));
  expect(byName["Owner"]).toEqual(["*"]);
  expect(byName["Cashier"]).toEqual(["orders.create", "orders.settle", "menu.stock"]);
  expect(byName["Kitchen"]).toEqual(["kds.operate", "menu.stock"]);

  const outlets = await prisma.outlet.findMany({ where: { tenantId } });
  expect(outlets).toHaveLength(1);

  const owner = await prisma.user.findUnique({ where: { id: ownerId }, include: { userOutlets: true } });
  expect(owner?.tenantId).toBe(tenantId);
  expect(owner?.emailVerified).toBe(true);
  expect(owner?.userOutlets).toHaveLength(1);
  expect(await bcrypt.compare("secret12", owner!.passwordHash)).toBe(true);
});

it("runs unscoped: ignores an ambient tenant context", async () => {
  // Simulate being called inside another tenant's request context.
  enterTenant("some-other-tenant-id");
  const { tenantId } = await svc().provisionTenant({
    restaurantName: "R2", ownerName: "B", ownerEmail: "b@x.com", ownerPassword: "secret12", createdVia: "ADMIN",
  });
  expect(tenantId).not.toBe("some-other-tenant-id");
  // Verify via the raw (unextended) test client rather than another PrismaService.
  // The ambient tenant context set by enterTenant() above is still active in this
  // continuation (runUnscoped only suspends scoping for the duration of the
  // engine's own call), so a *new*, standalone PrismaService read here — even one
  // wrapped in its own runUnscoped() — is not reliably unscoped: Prisma's engine
  // dispatch for a standalone (non-transactional) query can resolve against
  // whatever ambient AsyncLocalStorage context is current at dispatch time rather
  // than the context captured at the call site, so it would be transparently
  // filtered to "some-other-tenant-id" and never find the real owner — a false
  // negative unrelated to the engine's correctness. testPrisma carries no
  // tenant-scope extension at all, so it verifies the raw DB state directly.
  const owner = await testPrisma.user.findFirst({ where: { email: "b@x.com" } });
  expect(owner?.tenantId).toBe(tenantId); // NOT the ambient id
});

it("rejects a duplicate owner email", async () => {
  const input = { restaurantName: "R", ownerName: "C", ownerEmail: "dupe@x.com", ownerPassword: "secret12", createdVia: "ADMIN" as const };
  await svc().provisionTenant(input);
  await expect(svc().provisionTenant(input)).rejects.toThrow();
});
