import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { base32Decode, base32Encode, hotp, totp, verifyTotp, timeStep } from "../src/mfa/totp";
import { testPrisma } from "./db";
import { PASSWORD, bootApp, seedTenant } from "./platform-helpers";

describe("RFC 6238 / 4226 TOTP", () => {
  // RFC 4226 Appendix D: secret "12345678901234567890", counters 0..9.
  const rfcSecret = Buffer.from("12345678901234567890");
  const hotpVectors = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];

  it("matches the RFC 4226 HOTP vectors", () => {
    hotpVectors.forEach((v, i) => expect(hotp(rfcSecret, i)).toBe(v));
  });

  it("matches the RFC 6238 SHA-1 vectors (last 6 digits)", () => {
    const b32 = base32Encode(rfcSecret);
    const vectors: [number, string][] = [
      [59, "287082"],
      [1111111109, "081804"],
      [1111111111, "050471"],
      [1234567890, "005924"],
      [2000000000, "279037"],
      [20000000000, "353130"],
    ];
    for (const [t, code] of vectors) expect(totp(b32, t * 1000)).toBe(code);
  });

  it("round-trips base32 and tolerates ±1 step of drift", () => {
    const b32 = base32Encode(Buffer.from("hello world!"));
    expect(base32Decode(b32).toString()).toBe("hello world!");
    const now = 1_700_000_000_000;
    const prev = totp(b32, now - 30_000);
    expect(verifyTotp(b32, prev, now)).toBe(timeStep(now) - 1);
    expect(verifyTotp(b32, totp(b32, now - 90_000), now)).toBeNull();
    expect(verifyTotp(b32, "12345", now)).toBeNull();
  });
});

describe("2FA flows", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await bootApp();
  });
  afterAll(async () => {
    await app.close();
  });

  const login = (email: string) =>
    request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password: PASSWORD });

  async function enrol(token: string) {
    const setup = await request(app.getHttpServer()).post("/api/v1/auth/mfa/setup").set("Authorization", `Bearer ${token}`);
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const secret = setup.body.secret as string;
    // Use the previous step so the immediate login challenge (current step) is not a replay.
    const enable = await request(app.getHttpServer())
      .post("/api/v1/auth/mfa/enable")
      .set("Authorization", `Bearer ${token}`)
      .send({ code: totp(secret, Date.now() - 30_000) });
    expect(enable.status).toBe(200);
    expect(enable.body.recoveryCodes).toHaveLength(10);
    return { secret, recoveryCodes: enable.body.recoveryCodes as string[] };
  }

  it("enrol -> login requires a code -> code issues a session; replay is refused", async () => {
    const { owner } = await seedTenant();
    const first = await login(owner.email);
    const { secret } = await enrol(first.body.accessToken);
    // Recovery codes are stored hashed, never in clear.
    const stored = await testPrisma.mfaRecoveryCode.findMany({ where: { userId: owner.id } });
    expect(stored).toHaveLength(10);
    expect(stored.every((r) => /^[0-9a-f]{64}$/.test(r.codeHash))).toBe(true);

    const step = await login(owner.email);
    expect(step.body).toEqual({ mfa: "verify", mfaToken: expect.any(String) });
    expect(step.body.accessToken).toBeUndefined();

    // The step-up token is not a session.
    const misuse = await request(app.getHttpServer()).get("/api/v1/auth/me").set("Authorization", `Bearer ${step.body.mfaToken}`);
    expect(misuse.status).toBe(401);

    const bad = await request(app.getHttpServer()).post("/api/v1/auth/mfa/challenge").send({ mfaToken: step.body.mfaToken, code: "000000" });
    expect(bad.status).toBe(401);

    const code = totp(secret);
    const ok = await request(app.getHttpServer()).post("/api/v1/auth/mfa/challenge").send({ mfaToken: step.body.mfaToken, code });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();

    const again = await login(owner.email);
    const replay = await request(app.getHttpServer()).post("/api/v1/auth/mfa/challenge").send({ mfaToken: again.body.mfaToken, code });
    expect(replay.status).toBe(401);
  });

  it("recovery codes work exactly once", async () => {
    const { owner } = await seedTenant();
    const { recoveryCodes } = await enrol((await login(owner.email)).body.accessToken);
    const step = await login(owner.email);
    const use = await request(app.getHttpServer())
      .post("/api/v1/auth/mfa/challenge")
      .send({ mfaToken: step.body.mfaToken, recoveryCode: recoveryCodes[0].toUpperCase() });
    expect(use.status).toBe(200);
    const step2 = await login(owner.email);
    const reuse = await request(app.getHttpServer())
      .post("/api/v1/auth/mfa/challenge")
      .send({ mfaToken: step2.body.mfaToken, recoveryCode: recoveryCodes[0] });
    expect(reuse.status).toBe(401);
    const status = await request(app.getHttpServer()).get("/api/v1/auth/mfa").set("Authorization", `Bearer ${use.body.accessToken}`);
    expect(status.body.recoveryCodesRemaining).toBe(9);
  });

  it("disable needs the password and a current code", async () => {
    const { owner } = await seedTenant();
    const token = (await login(owner.email)).body.accessToken;
    const { secret } = await enrol(token);
    const auth = { Authorization: `Bearer ${token}` };
    const wrongPw = await request(app.getHttpServer()).post("/api/v1/auth/mfa/disable").set(auth).send({ password: "nope", code: totp(secret) });
    expect(wrongPw.status).toBe(401);
    const noCode = await request(app.getHttpServer()).post("/api/v1/auth/mfa/disable").set(auth).send({ password: PASSWORD });
    expect(noCode.status).toBe(400);
    const ok = await request(app.getHttpServer()).post("/api/v1/auth/mfa/disable").set(auth).send({ password: PASSWORD, code: totp(secret) });
    expect(ok.status).toBe(200);
    expect((await login(owner.email)).body.accessToken).toBeTruthy();
    expect(await testPrisma.auditLog.count({ where: { action: "MFA_DISABLED" } })).toBe(1);
  });

  it("(fresh app: the login route is throttled to 10/min per IP)", async () => {
    await app.close();
    app = await bootApp();
  });

  it("tenant policy forces owners to enrol during login; staff are unaffected", async () => {
    const { owner, addUser } = await seedTenant();
    const { user: cashier } = await addUser("cashier@platform.test", ["orders.create"]);
    const token = (await login(owner.email)).body.accessToken;
    const auth = { Authorization: `Bearer ${token}` };

    // An owner can't require 2FA before turning it on for themselves.
    const early = await request(app.getHttpServer()).put("/api/v1/security/settings").set(auth).send({ requireOwnerMfa: true });
    expect(early.status).toBe(400);

    // A second owner without 2FA.
    const { user: coOwner } = await addUser("coowner@platform.test", ["*"], "Co-owner");
    await enrol(token);
    const set = await request(app.getHttpServer()).put("/api/v1/security/settings").set(auth).send({ requireOwnerMfa: true });
    expect(set.status).toBe(200);

    const step = await login(coOwner.email);
    expect(step.body.mfa).toBe("enroll");
    const start = await request(app.getHttpServer()).post("/api/v1/auth/mfa/enroll/start").send({ mfaToken: step.body.mfaToken });
    expect(start.status).toBe(200);
    const confirm = await request(app.getHttpServer())
      .post("/api/v1/auth/mfa/enroll/confirm")
      .send({ mfaToken: step.body.mfaToken, code: totp(start.body.secret) });
    expect(confirm.status).toBe(200);
    expect(confirm.body.accessToken).toBeTruthy();
    expect(confirm.body.recoveryCodes).toHaveLength(10);

    // Policy blocks the owner from switching 2FA off.
    const coAuth = { Authorization: `Bearer ${confirm.body.accessToken}` };
    const off = await request(app.getHttpServer()).post("/api/v1/auth/mfa/disable").set(coAuth).send({ password: PASSWORD });
    expect(off.status).toBe(400);

    expect((await login(cashier.email)).body.accessToken).toBeTruthy();
  });
});
