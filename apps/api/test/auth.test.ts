import { expect, it } from "vitest";
import { PrismaService } from "../src/prisma/prisma.service";
import { AuthService } from "../src/auth/auth.service";
import { JwtService } from "@nestjs/jwt";

it("resolveUser reflects isPlatformAdmin", async () => {
  const prisma = new PrismaService();
  const auth = new AuthService(prisma, new JwtService({ secret: "test" }));
  const tenant = await prisma.tenant.create({ data: { name: "T" } });
  const role = await prisma.role.create({ data: { tenantId: tenant.id, name: "Owner", permissions: ["*"] } });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, email: "p@a.com", passwordHash: "x", name: "P", roleId: role.id, isPlatformAdmin: true },
  });
  const resolved = await auth.resolveUser(user.id);
  expect(resolved.isPlatformAdmin).toBe(true);
});
