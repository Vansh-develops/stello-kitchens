import { expect, it } from "vitest";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../src/prisma/prisma.service";
import { PasswordResetService } from "../src/account/password-reset.service";
import { LoggingEmailProvider } from "../src/email/email.provider";
import { testPrisma } from "./db";

async function seedUser(email: string) {
  const t = await testPrisma.tenant.create({ data: { name: "T" } });
  const r = await testPrisma.role.create({ data: { tenantId: t.id, name: "Owner", permissions: ["*"] } });
  return testPrisma.user.create({ data: { tenantId: t.id, email, passwordHash: await bcrypt.hash("old12345",10), name: "U", roleId: r.id } });
}
function svc() { return new PasswordResetService(new PrismaService(), new LoggingEmailProvider()); }

it("issues a reset token and resets the password", async () => {
  const u = await seedUser("reset@x.com");
  const raw = await svc().requestReset("reset@x.com"); // test-only: returns raw token
  expect(raw).toBeTruthy();
  await svc().reset(raw!, "newpass12");
  const fresh = await testPrisma.user.findUnique({ where: { id: u.id } });
  expect(await bcrypt.compare("newpass12", fresh!.passwordHash)).toBe(true);
});
it("requestReset returns null for unknown email (no enumeration) and reset rejects reused/invalid token", async () => {
  expect(await svc().requestReset("nobody@x.com")).toBeNull();
  const u = await seedUser("r2@x.com");
  const raw = await svc().requestReset("r2@x.com");
  await svc().reset(raw!, "newpass12");
  await expect(svc().reset(raw!, "again1234")).rejects.toThrow(); // single-use
});
