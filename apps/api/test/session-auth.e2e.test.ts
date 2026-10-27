import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { JwtService } from "@nestjs/jwt";
import { RealtimeGateway } from "../src/realtime/realtime.gateway";
import { PrismaService } from "../src/prisma/prisma.service";
import { testPrisma } from "./db";
import { PASSWORD, bootApp, cookiesFrom, seedTenant } from "./platform-helpers";

/**
 * Browser sessions live in an httpOnly cookie with a session-bound CSRF token;
 * Bearer auth keeps working for non-browser clients; tokenVersion revocation
 * applies to both.
 */
describe("cookie session + CSRF", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await bootApp();
  });
  afterAll(async () => {
    await app.close();
  });

  async function cookieLogin(email: string) {
    const res = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .set("X-Session-Mode", "cookie")
      .send({ email, password: PASSWORD });
    expect(res.status).toBe(201);
    const jar = cookiesFrom(res.headers["set-cookie"]);
    return { res, jar, cookie: `stello_session=${jar.stello_session.value}; stello_csrf=${jar.stello_csrf.value}`, csrf: res.body.csrfToken as string };
  }

  it("cookie mode sets an httpOnly SameSite=Lax session and never returns the JWT", async () => {
    const { owner } = await seedTenant();
    const { res, jar, csrf } = await cookieLogin(owner.email);
    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.user.email).toBe(owner.email);
    expect(jar.stello_session.raw).toMatch(/HttpOnly/i);
    expect(jar.stello_session.raw).toMatch(/SameSite=Lax/i);
    expect(jar.stello_csrf.raw).not.toMatch(/HttpOnly/i);
    expect(jar.stello_csrf.value).toBe(csrf);
  });

  it("bearer mode (no header) still returns an access token and sets no cookie", async () => {
    const { owner } = await seedTenant();
    const res = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email: owner.email, password: PASSWORD });
    expect(res.body.accessToken).toBeTruthy();
    expect(res.headers["set-cookie"]).toBeUndefined();
    const me = await request(app.getHttpServer()).get("/api/v1/auth/me").set("Authorization", `Bearer ${res.body.accessToken}`);
    expect(me.status).toBe(200);
    // Bearer requests need no CSRF token.
    const post = await request(app.getHttpServer())
      .post("/api/v1/auth/mfa/setup")
      .set("Authorization", `Bearer ${res.body.accessToken}`);
    expect(post.status).toBe(200);
  });

  it("cookie authenticates reads; unsafe methods need the matching CSRF header", async () => {
    const { owner } = await seedTenant();
    const { cookie, csrf } = await cookieLogin(owner.email);
    const server = app.getHttpServer();

    expect((await request(server).get("/api/v1/auth/me").set("Cookie", cookie)).status).toBe(200);

    const noHeader = await request(server).post("/api/v1/auth/mfa/setup").set("Cookie", cookie);
    expect(noHeader.status).toBe(403);
    const wrong = await request(server).post("/api/v1/auth/mfa/setup").set("Cookie", cookie).set("X-CSRF-Token", "x".repeat(32));
    expect(wrong.status).toBe(403);
    const ok = await request(server).post("/api/v1/auth/mfa/setup").set("Cookie", cookie).set("X-CSRF-Token", csrf);
    expect(ok.status).toBe(200);
  });

  it("a planted csrf cookie can't satisfy the check (token is bound to the signed session)", async () => {
    const { owner } = await seedTenant();
    const { jar } = await cookieLogin(owner.email);
    const forged = `stello_session=${jar.stello_session.value}; stello_csrf=attacker`;
    const res = await request(app.getHttpServer())
      .post("/api/v1/auth/mfa/setup")
      .set("Cookie", forged)
      .set("X-CSRF-Token", "attacker");
    expect(res.status).toBe(403);
  });

  it("logout clears both cookies; logout-all revokes every session via tokenVersion", async () => {
    const { owner } = await seedTenant();
    const server = app.getHttpServer();
    const out = await request(server).post("/api/v1/auth/logout");
    const cleared = cookiesFrom(out.headers["set-cookie"]);
    expect(cleared.stello_session.value).toBe("");
    expect(cleared.stello_csrf.value).toBe("");

    const a = await cookieLogin(owner.email);
    const bearer = (await request(server).post("/api/v1/auth/login").send({ email: owner.email, password: PASSWORD })).body.accessToken;
    const revoke = await request(server).post("/api/v1/auth/logout-all").set("Cookie", a.cookie).set("X-CSRF-Token", a.csrf);
    expect(revoke.status).toBe(200);
    expect((await request(server).get("/api/v1/auth/me").set("Cookie", a.cookie)).status).toBe(401);
    expect((await request(server).get("/api/v1/auth/me").set("Authorization", `Bearer ${bearer}`)).status).toBe(401);
    expect((await testPrisma.auditLog.count({ where: { action: "SESSIONS_REVOKED" } }))).toBe(1);
  });

  it("invite-accept issues a session that the guard accepts (carries tokenVersion)", async () => {
    const { tenant, ownerRole } = await seedTenant();
    const { newToken } = await import("../src/common/token");
    const { raw, hash } = newToken();
    await testPrisma.authToken.create({
      data: { type: "INVITE", tenantId: tenant.id, roleId: ownerRole.id, email: "new@stello.test", tokenHash: hash, expiresAt: new Date(Date.now() + 60_000) },
    });
    const res = await request(app.getHttpServer())
      .post("/api/v1/invite/accept")
      .set("X-Session-Mode", "cookie")
      .send({ token: raw, name: "New", password: "password123" });
    expect(res.status).toBe(201);
    const jar = cookiesFrom(res.headers["set-cookie"]);
    const me = await request(app.getHttpServer()).get("/api/v1/auth/me").set("Cookie", `stello_session=${jar.stello_session.value}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe("new@stello.test");
  });
});

describe("socket auth via cookie", () => {
  const jwt = new JwtService({ secret: "dev-secret-change-me" });

  function fakeClient(headers: Record<string, string>, auth: Record<string, string> = {}) {
    let disconnected = false;
    return {
      handshake: { auth, headers },
      data: {} as Record<string, unknown>,
      disconnect: () => {
        disconnected = true;
      },
      get disconnected() {
        return disconnected;
      },
    };
  }

  it("accepts the session cookie from an allowed origin and rejects foreign origins", async () => {
    const { owner } = await seedTenant();
    const token = await jwt.signAsync({ sub: owner.id, tenantId: owner.tenantId, tokenVersion: 0, csrf: "c" });
    const prisma = new PrismaService();
    const gw = new RealtimeGateway(jwt, prisma);
    const prev = process.env.CORS_ORIGINS;
    process.env.CORS_ORIGINS = "https://kitchens.example";
    try {
      const good = fakeClient({ cookie: `stello_session=${token}`, origin: "https://kitchens.example" });
      await gw.handleConnection(good as never);
      expect(good.disconnected).toBe(false);
      expect(good.data.tenantId).toBe(owner.tenantId);

      const evil = fakeClient({ cookie: `stello_session=${token}`, origin: "https://evil.example" });
      await gw.handleConnection(evil as never);
      expect(evil.disconnected).toBe(true);

      // Bearer-style auth.token is unaffected by Origin.
      const bearer = fakeClient({ origin: "app://edge" }, { token });
      await gw.handleConnection(bearer as never);
      expect(bearer.disconnected).toBe(false);

      // MFA step-up tokens are not sessions.
      const stepUp = await jwt.signAsync({ sub: owner.id, tenantId: owner.tenantId, tokenVersion: 0, purpose: "mfa" });
      const s = fakeClient({}, { token: stepUp });
      await gw.handleConnection(s as never);
      expect(s.disconnected).toBe(true);
    } finally {
      process.env.CORS_ORIGINS = prev;
      await prisma.$disconnect();
    }
  });
});
