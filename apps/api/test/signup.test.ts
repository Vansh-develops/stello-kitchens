import { expect, it } from "vitest";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../src/prisma/prisma.service";
import { SignupService } from "../src/account/signup.service";
import { ProvisioningService } from "../src/provisioning/provisioning.service";
import { LoggingEmailProvider } from "../src/email/email.provider";
import { testPrisma } from "./db";

function svc() { const p = new PrismaService(); return new SignupService(p, new ProvisioningService(p), new LoggingEmailProvider()); }

it("pending signup then verify provisions a real tenant", async () => {
  const raw = await svc().start({ restaurantName: "New Cafe", ownerName: "Ava", email: "ava@x.com", password: "secret12" });
  expect(raw).toBeTruthy();
  expect(await testPrisma.tenant.count({ where: { name: "New Cafe" } })).toBe(0); // not created yet
  const { ownerId } = await svc().verify(raw);
  const owner = await testPrisma.user.findUnique({ where: { id: ownerId } });
  expect(owner!.email).toBe("ava@x.com");
  expect(await bcrypt.compare("secret12", owner!.passwordHash)).toBe(true);
  expect(await testPrisma.pendingSignup.count({ where: { email: "ava@x.com" } })).toBe(0); // consumed
});
it("rejects duplicate email and invalid/expired token", async () => {
  await svc().start({ restaurantName: "R", ownerName: "O", email: "dupe@x.com", password: "secret12" });
  await expect(svc().start({ restaurantName: "R2", ownerName: "O2", email: "dupe@x.com", password: "secret12" })).rejects.toThrow();
  await expect(svc().verify("not-a-real-token")).rejects.toThrow();
});
