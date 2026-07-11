import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { testPrisma } from "./db";

/**
 * End-to-end proof that /platform/tenants is actually gated by the real guard
 * chain (ThrottlerGuard -> JwtAuthGuard -> PlatformAdminGuard), exercised over
 * HTTP against the booted app rather than by inspecting decorators.
 *
 * Note: the shared harness (test/db.ts) truncates every table in a top-level
 * `beforeEach` before each test runs, including the first test in this file.
 * So seeding must happen in a `beforeEach` here too (which nests *after* the
 * harness's), not in `beforeAll` — otherwise the harness's truncate would
 * wipe out data seeded in `beforeAll` before the first test ever saw it.
 */
describe("platform tenants e2e", () => {
  let app: INestApplication;

  const adminEmail = "admin-e2e@stello.test";
  const normalEmail = "normal-e2e@stello.test";
  const password = "supersecret1";

  let adminToken: string;
  let normalToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const passwordHash = await bcrypt.hash(password, 10);

    // Tenant + platform-admin owner.
    const adminTenant = await testPrisma.tenant.create({ data: { name: "Admin Tenant" } });
    const adminRole = await testPrisma.role.create({
      data: { tenantId: adminTenant.id, name: "Owner", permissions: ["*"] },
    });
    await testPrisma.user.create({
      data: {
        tenantId: adminTenant.id,
        email: adminEmail,
        passwordHash,
        name: "Admin Owner",
        roleId: adminRole.id,
        isPlatformAdmin: true,
      },
    });

    // Separate tenant + normal (non-admin) user.
    const normalTenant = await testPrisma.tenant.create({ data: { name: "Normal Tenant" } });
    const normalRole = await testPrisma.role.create({
      data: { tenantId: normalTenant.id, name: "Cashier", permissions: ["orders.create"] },
    });
    await testPrisma.user.create({
      data: {
        tenantId: normalTenant.id,
        email: normalEmail,
        passwordHash,
        name: "Normal User",
        roleId: normalRole.id,
        isPlatformAdmin: false,
      },
    });

    const adminLogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: adminEmail, password });
    adminToken = adminLogin.body.accessToken;

    const normalLogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: normalEmail, password });
    normalToken = normalLogin.body.accessToken;
  });

  it("rejects a non-admin JWT with 403", async () => {
    expect(normalToken).toBeTruthy();
    const res = await request(app.getHttpServer())
      .post("/api/v1/platform/tenants")
      .set("Authorization", `Bearer ${normalToken}`)
      .send({
        restaurantName: "Should Not Be Created",
        ownerName: "Nope",
        ownerEmail: "nope-e2e@stello.test",
        ownerPassword: "irrelevant1",
      });
    expect(res.status).toBe(403);
  });

  it("rejects a request with no token with 401", async () => {
    const res = await request(app.getHttpServer()).post("/api/v1/platform/tenants").send({
      restaurantName: "Should Not Be Created Either",
      ownerName: "Nope",
      ownerEmail: "nope2-e2e@stello.test",
      ownerPassword: "irrelevant1",
    });
    expect(res.status).toBe(401);
  });

  it("allows an admin JWT to create a tenant (201) and lists it", async () => {
    expect(adminToken).toBeTruthy();
    const createRes = await request(app.getHttpServer())
      .post("/api/v1/platform/tenants")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        restaurantName: "Spice Route E2E",
        ownerName: "Asha E2E",
        ownerEmail: "asha-e2e@stello.test",
        ownerPassword: "secret1234",
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.tenantId).toBeTruthy();

    const listRes = await request(app.getHttpServer())
      .get("/api/v1/platform/tenants")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.some((t: { id: string }) => t.id === createRes.body.tenantId)).toBe(true);
  });
});
