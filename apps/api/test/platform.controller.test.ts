import { expect, it } from "vitest";
import { PrismaService } from "../src/prisma/prisma.service";
import { ProvisioningService } from "../src/provisioning/provisioning.service";
import { PlatformController } from "../src/provisioning/platform.controller";

it("creates a tenant and lists it", async () => {
  const prisma = new PrismaService();
  const ctrl = new PlatformController(new ProvisioningService(prisma), prisma);
  const res = await ctrl.create({
    restaurantName: "Spice Route", ownerName: "Asha", ownerEmail: "a@x.com", ownerPassword: "secret12",
  });
  expect(res.tenantId).toBeTruthy();
  const list = await ctrl.list();
  expect(list.find((t) => t.id === res.tenantId)?.name).toBe("Spice Route");
});
