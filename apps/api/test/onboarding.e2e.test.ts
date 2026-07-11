import { Test } from "@nestjs/testing";
import request from "supertest";
import * as bcrypt from "bcryptjs";
import { expect, it, beforeAll, afterAll } from "vitest";
import { AppModule } from "../src/app.module";
import { testPrisma } from "./db";

let app: any;
beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.setGlobalPrefix("api/v1");
  await app.init();
});
afterAll(async () => { await app?.close(); });

async function owner(email: string) {
  const t = await testPrisma.tenant.create({ data: { name: "T" } });
  const b = await testPrisma.brand.create({ data: { tenantId: t.id, name: "B" } });
  const o = await testPrisma.outlet.create({ data: { tenantId: t.id, brandId: b.id, name: "O" } });
  const role = await testPrisma.role.create({ data: { tenantId: t.id, name: "Owner", permissions: ["*"] } });
  await testPrisma.user.create({ data: { tenantId: t.id, email, passwordHash: await bcrypt.hash("password123", 10), name: "Own", roleId: role.id, userOutlets: { create: [{ outletId: o.id }] } } });
  return { t, o };
}
async function login(email: string) {
  const r = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password: "password123" });
  return r.body.accessToken as string;
}

it("owner can PATCH own outlet; cannot PATCH another tenant's outlet", async () => {
  const A = await owner("a-e2e@x.com");
  const B = await owner("b-e2e@x.com");
  const tokenA = await login("a-e2e@x.com");

  const ok = await request(app.getHttpServer())
    .patch(`/api/v1/outlets/${A.o.id}`).set("Authorization", `Bearer ${tokenA}`).send({ address: "New Rd" });
  expect(ok.status).toBe(200);

  const cross = await request(app.getHttpServer())
    .patch(`/api/v1/outlets/${B.o.id}`).set("Authorization", `Bearer ${tokenA}`).send({ name: "hacked" });
  expect([403, 404]).toContain(cross.status); // no access to outlet (403) — never 200
});
