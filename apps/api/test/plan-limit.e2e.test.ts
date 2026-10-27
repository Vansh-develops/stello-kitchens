import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import request from "supertest";
import { PLAN_CATALOGUE } from "@stello/shared";
import { AppModule } from "../src/app.module";
import { testPrisma } from "./db";

/**
 * Plan enforcement over HTTP through the real guard chain
 * (Throttler → JwtAuth → RequirePermission → PlanGuard).
 */
describe("plan-limit guard e2e", () => {
  let app: INestApplication;
  let token: string;
  let outletId: string;
  let brandId: string;
  let tenantId: string;

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
    await testPrisma.plan.createMany({
      data: PLAN_CATALOGUE.map((p) => ({
        code: p.code, name: p.name, priceMonthly: p.priceMonthly, priceYearly: p.priceYearly,
        limits: p.limits, features: p.features, sortOrder: p.sortOrder,
      })),
    });
    const starter = await testPrisma.plan.findUniqueOrThrow({ where: { code: "starter" } });
    const tenant = await testPrisma.tenant.create({ data: { name: "Limits Ltd", status: "ACTIVE" } });
    tenantId = tenant.id;
    await testPrisma.tenantSubscription.create({
      data: {
        tenantId, planId: starter.id, status: "ACTIVE",
        currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    const brand = await testPrisma.brand.create({ data: { tenantId, name: "Limits" } });
    brandId = brand.id;
    const outlet = await testPrisma.outlet.create({ data: { tenantId, brandId, name: "Main" } });
    outletId = outlet.id;
    const role = await testPrisma.role.create({ data: { tenantId, name: "Owner", permissions: ["*"] } });
    await testPrisma.user.create({
      data: {
        tenantId, email: "owner@limits.test", passwordHash: await bcrypt.hash("password123", 10), name: "Owner",
        roleId: role.id, userOutlets: { create: [{ outletId }] },
      },
    });
    const login = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "owner@limits.test", password: "password123" });
    token = login.body.accessToken;
  });

  const api = () => request(app.getHttpServer());

  it("rejects the terminal beyond the plan limit", async () => {
    for (const name of ["POS 1", "KDS 1"]) {
      const ok = await api().post(`/api/v1/outlets/${outletId}/devices`).set("Authorization", `Bearer ${token}`).send({ name, type: "POS" });
      expect(ok.status).toBe(201);
    }
    const over = await api().post(`/api/v1/outlets/${outletId}/devices`).set("Authorization", `Bearer ${token}`).send({ name: "POS 2", type: "POS" });
    expect(over.status).toBe(403);
    expect(over.body).toMatchObject({ code: "PLAN_LIMIT", resource: "terminals", limit: 2, usage: 2 });
  });

  it("gates the brand master menu behind the chain plan, and outlets behind the outlet limit", async () => {
    const gated = await api().get("/api/v1/chain/brands").set("Authorization", `Bearer ${token}`);
    expect(gated.status).toBe(403);
    expect(gated.body).toMatchObject({ code: "PLAN_FEATURE", feature: "chain_menu" });

    const chain = await testPrisma.plan.findUniqueOrThrow({ where: { code: "chain" } });
    await testPrisma.tenantSubscription.update({ where: { tenantId }, data: { planId: chain.id } });
    const open = await api().get("/api/v1/chain/brands").set("Authorization", `Bearer ${token}`);
    expect(open.status).toBe(200);
    expect(open.body[0]).toMatchObject({ id: brandId, outletCount: 1 });

    const created = await api()
      .post(`/api/v1/chain/brands/${brandId}/outlets`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Second outlet" });
    expect(created.status).toBe(201);

    // Squeeze the limit to the current usage: the next outlet is refused.
    await testPrisma.plan.update({ where: { code: "chain" }, data: { limits: { outlets: 2, terminals: 100, users: 250 } } });
    const over = await api()
      .post(`/api/v1/chain/brands/${brandId}/outlets`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Third outlet" });
    expect(over.status).toBe(403);
    expect(over.body).toMatchObject({ code: "PLAN_LIMIT", resource: "outlets" });
  });

  it("blocks metered writes while the subscription is past its life", async () => {
    await testPrisma.tenantSubscription.update({ where: { tenantId }, data: { status: "CANCELLED" } });
    const res = await api().post(`/api/v1/outlets/${outletId}/devices`).set("Authorization", `Bearer ${token}`).send({ name: "POS", type: "POS" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SUBSCRIPTION_INACTIVE");
  });

  it("serves the billing page data and stores the user's language", async () => {
    const sub = await api().get("/api/v1/subscription").set("Authorization", `Bearer ${token}`);
    expect(sub.status).toBe(200);
    expect(sub.body).toMatchObject({ status: "ACTIVE", plan: { code: "starter" }, usage: { outlets: 1, users: 1 } });

    const bad = await api().put("/api/v1/me/preferences").set("Authorization", `Bearer ${token}`).send({ locale: "fr" });
    expect(bad.status).toBe(400);
    const put = await api().put("/api/v1/me/preferences").set("Authorization", `Bearer ${token}`).send({ locale: "hi" });
    expect(put.body).toEqual({ locale: "hi" });
    const got = await api().get("/api/v1/me/preferences").set("Authorization", `Bearer ${token}`);
    expect(got.body).toEqual({ locale: "hi" });
  });
});
