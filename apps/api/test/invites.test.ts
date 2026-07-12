import { expect, it } from "vitest";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../src/prisma/prisma.service";
import { InvitesService } from "../src/account/invites.service";
import { LoggingEmailProvider } from "../src/email/email.provider";
import { testPrisma } from "./db";

async function seedTenant() {
  const t = await testPrisma.tenant.create({ data: { name: "Spice" } });
  const b = await testPrisma.brand.create({ data: { tenantId: t.id, name: "Spice" } });
  const o = await testPrisma.outlet.create({ data: { tenantId: t.id, brandId: b.id, name: "Main" } });
  const cashier = await testPrisma.role.create({ data: { tenantId: t.id, name: "Cashier", permissions: ["orders.create"] } });
  return { t, o, cashier };
}
const user = (tid: string) => ({ id: "u", tenantId: tid, email: "own@x.com", name: "O", roleName: "Owner", permissions: ["*"], outletIds: [], isPlatformAdmin: false }) as any;
function svc() { return new InvitesService(new PrismaService(), new LoggingEmailProvider()); }

it("owner invites a cashier; accept creates the user with that tenant+role", async () => {
  const { t, o, cashier } = await seedTenant();
  const { inviteLink, raw } = await svc().create(user(t.id), { email: "new@x.com", roleId: cashier.id });
  expect(inviteLink).toContain(raw);
  const res = await svc().accept(raw, { name: "New Staff", password: "secret12", token: raw });
  expect(res.user.email).toBe("new@x.com");
  const created = await testPrisma.user.findUnique({ where: { email: "new@x.com" }, include: { userOutlets: true, role: true } });
  expect(created!.tenantId).toBe(t.id);
  expect(created!.roleId).toBe(cashier.id);
  expect(await bcrypt.compare("secret12", created!.passwordHash)).toBe(true);
});
it("rejects inviting with a role from another tenant, and rejects reused invite token", async () => {
  const a = await seedTenant();
  const b = await seedTenant();
  await expect(svc().create(user(a.t.id), { email: "x@x.com", roleId: b.cashier.id })).rejects.toThrow();
  const { raw } = await svc().create(user(a.t.id), { email: "y@x.com", roleId: a.cashier.id });
  await svc().accept(raw, { name: "Y", password: "secret12", token: raw });
  await expect(svc().accept(raw, { name: "Y2", password: "secret12", token: raw })).rejects.toThrow();
});
