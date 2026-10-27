import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { AppModule } from "../src/app.module";
import { testPrisma } from "./db";

export const PASSWORD = "supersecret1";

/** Boot the real AppModule (guards, pipes, controllers) for HTTP tests. */
export async function bootApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api/v1");
  await app.init();
  return app;
}

let passwordHash: string | null = null;

/** A tenant with one outlet and an owner; extra roles/users via addUser. */
export async function seedTenant(name = "Platform Cafe") {
  passwordHash ??= await bcrypt.hash(PASSWORD, 4);
  const tenant = await testPrisma.tenant.create({ data: { name, status: "ACTIVE" } });
  const brand = await testPrisma.brand.create({ data: { tenantId: tenant.id, name } });
  const outlet = await testPrisma.outlet.create({ data: { tenantId: tenant.id, brandId: brand.id, name: `${name} Main` } });
  const ownerRole = await testPrisma.role.create({ data: { tenantId: tenant.id, name: "Owner", permissions: ["*"] } });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const owner = await testPrisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `owner@${slug}.test`,
      passwordHash: passwordHash!,
      name: "Owner",
      roleId: ownerRole.id,
      userOutlets: { create: [{ outletId: outlet.id }] },
    },
  });
  const addUser = async (email: string, permissions: string[], roleName = `Role ${email}`) => {
    const role = await testPrisma.role.create({ data: { tenantId: tenant.id, name: roleName, permissions } });
    const user = await testPrisma.user.create({
      data: {
        tenantId: tenant.id,
        email,
        passwordHash: passwordHash!,
        name: email.split("@")[0],
        roleId: role.id,
        userOutlets: { create: [{ outletId: outlet.id }] },
      },
    });
    return { user, role };
  };
  return { tenant, brand, outlet, ownerRole, owner, addUser };
}

/** Pull `name=value` pairs out of Set-Cookie headers. */
export function cookiesFrom(setCookie: string[] | string | undefined): Record<string, { value: string; raw: string }> {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const out: Record<string, { value: string; raw: string }> = {};
  for (const raw of list) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    out[pair.slice(0, eq)] = { value: decodeURIComponent(pair.slice(eq + 1)), raw };
  }
  return out;
}
