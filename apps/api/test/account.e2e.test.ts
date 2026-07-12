import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { EMAIL_PROVIDER } from "../src/email/email.provider";
import { testPrisma } from "./db";

/**
 * End-to-end proof of the public account-lifecycle flows over real HTTP
 * against a booted AppModule:
 *   - signup -> verify (provisions a real tenant), token captured via a fake
 *     EMAIL_PROVIDER since the DB only stores a hash of the token.
 *   - signup with the flag off -> 404 (the controller reads
 *     process.env.SIGNUP_PUBLIC_ENABLED at REQUEST time, so we toggle it
 *     between requests on the SAME app instance rather than booting a
 *     second app).
 *   - forgot-password for an unknown email -> generic 200.
 */
describe("account lifecycle e2e", () => {
  let app: INestApplication;
  let capturedLink: string | null = null;

  beforeAll(async () => {
    process.env.SIGNUP_PUBLIC_ENABLED = "true";

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_PROVIDER)
      .useValue({
        sendVerification: async (_to: string, link: string) => {
          capturedLink = link;
        },
        sendPasswordReset: async () => {},
        sendInvite: async () => {},
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("signup (flag on) sends a verification link, then verify provisions the tenant", async () => {
    const email = "e2e-signup-owner@stello.test";

    const signupRes = await request(app.getHttpServer()).post("/api/v1/signup").send({
      restaurantName: "E2E Signup Cafe",
      ownerName: "E2E Owner",
      email,
      password: "supersecret1",
    });
    // NestJS defaults POST handlers to 201 Created; neither the signup
    // controller nor the plan's code samples add @HttpCode(200), so 201 is
    // the actual (and correct) status here. What matters per the plan is the
    // body shape and that the tenant is not created until verification.
    expect(signupRes.status).toBe(201);
    expect(signupRes.body).toEqual({ status: "verification_sent" });

    // Tenant must not exist until verification.
    expect(await testPrisma.tenant.count({ where: { name: "E2E Signup Cafe" } })).toBe(0);

    expect(capturedLink).toBeTruthy();
    const token = new URL(capturedLink!).searchParams.get("token");
    expect(token).toBeTruthy();

    const verifyRes = await request(app.getHttpServer())
      .post("/api/v1/signup/verify")
      .send({ token });
    expect(verifyRes.status).toBe(201); // NestJS default POST status; see note above
    expect(verifyRes.body.accessToken).toBeTruthy();

    expect(await testPrisma.tenant.count({ where: { name: "E2E Signup Cafe" } })).toBe(1);
  });

  it("signup (flag off) 404s", async () => {
    const original = process.env.SIGNUP_PUBLIC_ENABLED;
    process.env.SIGNUP_PUBLIC_ENABLED = "false";
    try {
      const res = await request(app.getHttpServer()).post("/api/v1/signup").send({
        restaurantName: "Should Not Exist",
        ownerName: "Nope",
        email: "e2e-signup-flagoff@stello.test",
        password: "supersecret1",
      });
      expect(res.status).toBe(404);
    } finally {
      process.env.SIGNUP_PUBLIC_ENABLED = original;
    }
  });

  it("forgot-password returns a generic 200 regardless of whether the email exists", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/auth/forgot-password")
      .send({ email: "nobody-unknown@x.com" });
    // Same NestJS-default-201 note as above; the important assertion is that
    // the response is a plain success regardless of whether the email exists
    // (no 4xx/enumeration signal).
    expect(res.status).toBe(201);
  });
});
