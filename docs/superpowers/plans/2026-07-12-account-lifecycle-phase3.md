# Account Lifecycle (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Self-serve account lifecycle — public signup (flag-gated), password reset, and staff invites — on one shared pluggable email + token foundation.

**Architecture:** An `EmailProvider` seam (logging impl now, real vendor later) and a hashed single-use `AuthToken`/`PendingSignup` foundation. Three flows: signup reuses the existing `ProvisioningService`; reset lives in the auth area; invites are owner-gated and create users under a token-bound tenant/role. Public Next.js pages mirror the existing `/login` mount pattern.

**Tech Stack:** NestJS 11, Prisma 6/PostgreSQL 16, TypeScript 5.8, Zod, bcryptjs, vitest + supertest harness (from Phase 1), Next.js 15 + React 19.

**Depends on:** Phases 1–2 (on `main`). Branch `feat/account-lifecycle` off `main`.

## Global Constraints

- TypeScript 5.8; NestJS 11; Prisma 6.8; pnpm workspaces (`--filter` from repo root). Next.js 15 dashboard.
- **Tokens:** 32 random bytes → base64url; stored **hashed** (sha256, hex); single-use (mark `usedAt` or delete row); expiry — reset **1h**, signup+invite **24h**. Raw token only ever appears inside the emailed/returned link. Reuse `apps/api/src/common/public-token.ts`'s `randomBytes` idiom; add a `hashToken` helper.
- **Passwords:** bcryptjs cost 10 (matches the codebase).
- **Security:** public routes (`/signup`, `/signup/verify`, `/auth/forgot-password`, `/auth/reset-password`, `/invite/accept`) are `@Public()` + per-route `@Throttle` (tight). Forgot-password never reveals whether an email exists (generic 200). Reset links are NEVER returned by any endpoint — only emailed. Invite links ARE returned to the authorizing owner.
- **Signup gating:** `SIGNUP_PUBLIC_ENABLED` env (default false). When not "true", `/signup` + `/signup/verify` return 404.
- **Link base URL:** `PUBLIC_APP_URL` env (default `https://kitchens.stellotechs.com`). Emailed/returned links are `${PUBLIC_APP_URL}/<path>?token=<raw>`.
- **Email:** never block a flow on email failure in a way that leaks info; the `LoggingEmailProvider` just logs. Real delivery is a later swap.
- Reuse `ProvisioningService.provisionTenant({ createdVia: "SIGNUP" })` for signup — no new provisioning logic.
- Frontend has no test harness — gate frontend tasks on `pnpm --filter @stello/dashboard exec tsc --noEmit` + `pnpm --filter @stello/dashboard build`; verify flows with the run skill (read logged links).
- Tests need local Docker Postgres (`docker compose up -d postgres`, container `stello-postgres`, 5455).

---

### Task 1: Shared schemas + DTOs

**Files:** Modify `packages/shared/src/schemas.ts`, `packages/shared/src/types.ts`; Test `packages/shared/src/schemas.account.test.ts`.

**Interfaces — Produces:** `SignupSchema` `{restaurantName,ownerName,email,password}`, `VerifyTokenSchema` `{token}`, `ForgotPasswordSchema` `{email}`, `ResetPasswordSchema` `{token,newPassword}`, `CreateInviteSchema` `{email,roleId}`, `AcceptInviteSchema` `{token,name,password}` (+ inferred `*Input` types); `RoleDto` `{id,name}`.

- [ ] **Step 1: Failing test** — create `packages/shared/src/schemas.account.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { SignupSchema, ResetPasswordSchema, CreateInviteSchema, AcceptInviteSchema } from "./schemas";
describe("account schemas", () => {
  it("SignupSchema requires valid email + password>=8", () => {
    expect(SignupSchema.safeParse({ restaurantName: "Cafe", ownerName: "O", email: "a@b.com", password: "secret12" }).success).toBe(true);
    expect(SignupSchema.safeParse({ restaurantName: "X", ownerName: "O", email: "x", password: "short" }).success).toBe(false);
  });
  it("ResetPasswordSchema requires token + newPassword>=8", () => {
    expect(ResetPasswordSchema.safeParse({ token: "t", newPassword: "secret12" }).success).toBe(true);
    expect(ResetPasswordSchema.safeParse({ token: "", newPassword: "123" }).success).toBe(false);
  });
  it("invite schemas validate", () => {
    expect(CreateInviteSchema.safeParse({ email: "a@b.com", roleId: "r1" }).success).toBe(true);
    expect(AcceptInviteSchema.safeParse({ token: "t", name: "N", password: "secret12" }).success).toBe(true);
  });
});
```
- [ ] **Step 2: Run to fail** — `pnpm --filter @stello/shared test account` → FAIL (schemas missing).
- [ ] **Step 3: Add schemas + types.** Append to `schemas.ts`:
```ts
export const SignupSchema = z.object({
  restaurantName: z.string().min(2).max(120),
  ownerName: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8).max(200),
});
export type SignupInput = z.infer<typeof SignupSchema>;
export const VerifyTokenSchema = z.object({ token: z.string().min(1) });
export type VerifyTokenInput = z.infer<typeof VerifyTokenSchema>;
export const ForgotPasswordSchema = z.object({ email: z.string().email() });
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;
export const ResetPasswordSchema = z.object({ token: z.string().min(1), newPassword: z.string().min(8).max(200) });
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;
export const CreateInviteSchema = z.object({ email: z.string().email(), roleId: z.string().min(1) });
export type CreateInviteInput = z.infer<typeof CreateInviteSchema>;
export const AcceptInviteSchema = z.object({ token: z.string().min(1), name: z.string().min(1).max(120), password: z.string().min(8).max(200) });
export type AcceptInviteInput = z.infer<typeof AcceptInviteSchema>;
```
Append to `types.ts`: `export interface RoleDto { id: string; name: string; }`
- [ ] **Step 4:** `pnpm --filter @stello/shared test account && pnpm --filter @stello/shared build` → PASS + dist.
- [ ] **Step 5: Commit** — `git add packages/shared/src && git commit -m "feat(shared): account-lifecycle schemas (signup, reset, invite) + RoleDto"`

---

### Task 2: Migration — PendingSignup + AuthToken

**Files:** Modify `apps/api/prisma/schema.prisma`; create migration; Test `apps/api/test/account-schema.test.ts`.

**Interfaces — Produces:** models `PendingSignup`, `AuthToken`; enum `AuthTokenType { PASSWORD_RESET, INVITE }`.

- [ ] **Step 1: Failing test** — `apps/api/test/account-schema.test.ts`:
```ts
import { expect, it } from "vitest";
import { testPrisma } from "./db";
it("stores PendingSignup and AuthToken rows", async () => {
  const ps = await testPrisma.pendingSignup.create({
    data: { email: "s@x.com", passwordHash: "h", restaurantName: "R", ownerName: "O", tokenHash: "th", expiresAt: new Date(Date.now()+3600e3) },
  });
  expect(ps.email).toBe("s@x.com");
  const t = await testPrisma.tenant.create({ data: { name: "T" } });
  const tok = await testPrisma.authToken.create({
    data: { type: "INVITE", tenantId: t.id, email: "i@x.com", tokenHash: "th2", expiresAt: new Date(Date.now()+3600e3) },
  });
  expect(tok.type).toBe("INVITE");
});
```
- [ ] **Step 2: Run to fail** — `pnpm --filter @stello/api test account-schema` → FAIL.
- [ ] **Step 3: Edit schema.** Add enum + models to `apps/api/prisma/schema.prisma`:
```prisma
enum AuthTokenType {
  PASSWORD_RESET
  INVITE
}

model PendingSignup {
  id             String   @id @default(cuid())
  email          String   @unique
  passwordHash   String
  restaurantName String
  ownerName      String
  tokenHash      String   @unique
  expiresAt      DateTime
  createdAt      DateTime @default(now())

  @@map("pending_signups")
}

model AuthToken {
  id        String        @id @default(cuid())
  type      AuthTokenType
  tenantId  String?
  userId    String?
  email     String?
  roleId    String?
  tokenHash String        @unique
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime      @default(now())

  @@index([tokenHash])
  @@map("auth_tokens")
}
```
- [ ] **Step 4:** `pnpm --filter @stello/api exec prisma migrate dev --name account_lifecycle_tokens` → created + applied.
- [ ] **Step 5:** `pnpm --filter @stello/api test account-schema` → PASS.
- [ ] **Step 6: Commit** — `git add apps/api/prisma/schema.prisma apps/api/prisma/migrations apps/api/test/account-schema.test.ts && git commit -m "feat(db): PendingSignup + AuthToken models for account lifecycle"`

---

### Task 3: Email seam + token helper

**Files:** Create `apps/api/src/email/email.provider.ts`, `apps/api/src/email/email.module.ts`, `apps/api/src/common/token.ts`; Test `apps/api/test/token.test.ts`.

**Interfaces — Produces:** `EMAIL_PROVIDER` DI token + `EmailProvider` interface + `LoggingEmailProvider`; `EmailModule` (global, exports the provider); `newToken(): { raw, hash }` and `hashToken(raw): string`.

- [ ] **Step 1: Failing test** — `apps/api/test/token.test.ts`:
```ts
import { expect, it } from "vitest";
import { newToken, hashToken } from "../src/common/token";
it("newToken returns a raw token and its stable hash", () => {
  const { raw, hash } = newToken();
  expect(raw.length).toBeGreaterThan(20);
  expect(hash).toBe(hashToken(raw));
  expect(hash).not.toBe(raw);
});
```
- [ ] **Step 2: Run to fail** — `pnpm --filter @stello/api test token` → FAIL.
- [ ] **Step 3: Implement.** Create `apps/api/src/common/token.ts`:
```ts
import { randomBytes, createHash } from "node:crypto";
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
export function newToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}
```
Create `apps/api/src/email/email.provider.ts`:
```ts
import { Injectable, Logger } from "@nestjs/common";
export const EMAIL_PROVIDER = "EMAIL_PROVIDER";
export interface EmailProvider {
  sendVerification(to: string, link: string): Promise<void>;
  sendPasswordReset(to: string, link: string): Promise<void>;
  sendInvite(to: string, link: string, restaurantName: string): Promise<void>;
}
/** Dev/default: logs the link. Swap for a real vendor by binding EMAIL_PROVIDER. */
@Injectable()
export class LoggingEmailProvider implements EmailProvider {
  private readonly log = new Logger("Email");
  async sendVerification(to: string, link: string) { this.log.log(`[verify] ${to} -> ${link}`); }
  async sendPasswordReset(to: string, link: string) { this.log.log(`[reset] ${to} -> ${link}`); }
  async sendInvite(to: string, link: string, r: string) { this.log.log(`[invite:${r}] ${to} -> ${link}`); }
}
```
Create `apps/api/src/email/email.module.ts`:
```ts
import { Global, Module } from "@nestjs/common";
import { EMAIL_PROVIDER, LoggingEmailProvider } from "./email.provider";
@Global()
@Module({
  providers: [{ provide: EMAIL_PROVIDER, useClass: LoggingEmailProvider }],
  exports: [EMAIL_PROVIDER],
})
export class EmailModule {}
```
Register `EmailModule` in `apps/api/src/app.module.ts` (import + imports array).
- [ ] **Step 4:** `pnpm --filter @stello/api test token && pnpm --filter @stello/api build` → PASS + build.
- [ ] **Step 5: Commit** — `git add apps/api/src/email apps/api/src/common/token.ts apps/api/src/app.module.ts apps/api/test/token.test.ts && git commit -m "feat(email): pluggable EmailProvider seam (logging impl) + token helpers"`

---

### Task 4: Password reset

**Files:** Create `apps/api/src/account/password-reset.service.ts`; modify `apps/api/src/auth/auth.controller.ts` (+ `auth.module.ts` to provide the service and import EmailModule if needed — EmailModule is global so just provide the service); Test `apps/api/test/password-reset.test.ts`.

**Interfaces — Consumes:** `PrismaService`, `EMAIL_PROVIDER`, `newToken/hashToken`, `ForgotPasswordSchema`/`ResetPasswordSchema`. **Produces:** `POST /auth/forgot-password`, `POST /auth/reset-password`.

- [ ] **Step 1: Failing test** — `apps/api/test/password-reset.test.ts`:
```ts
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
```
> Note: `requestReset` returns the raw token ONLY so tests can exercise `reset`; the CONTROLLER never returns it — it passes it to the email provider and responds generically.
- [ ] **Step 2: Run to fail** — `pnpm --filter @stello/api test password-reset` → FAIL.
- [ ] **Step 3: Implement service.** Create `apps/api/src/account/password-reset.service.ts`:
```ts
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";
import { EMAIL_PROVIDER, type EmailProvider } from "../email/email.provider";
import { newToken, hashToken } from "../common/token";
import { runUnscoped } from "../common/tenant-context";

const RESET_TTL_MS = 60 * 60 * 1000;
const APP_URL = () => process.env.PUBLIC_APP_URL ?? "https://kitchens.stellotechs.com";

@Injectable()
export class PasswordResetService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  /** Returns the raw token for TESTS only; the controller ignores the return and emails instead. */
  async requestReset(email: string): Promise<string | null> {
    const user = await runUnscoped(() => this.prisma.user.findUnique({ where: { email }, select: { id: true } }));
    if (!user) return null;
    const { raw, hash } = newToken();
    await runUnscoped(() => this.prisma.authToken.create({
      data: { type: "PASSWORD_RESET", userId: user.id, email, tokenHash: hash, expiresAt: new Date(Date.now() + RESET_TTL_MS) },
    }));
    await this.email.sendPasswordReset(email, `${APP_URL()}/reset-password?token=${raw}`);
    return raw;
  }

  async reset(rawToken: string, newPassword: string): Promise<void> {
    const hash = hashToken(rawToken);
    const tok = await runUnscoped(() => this.prisma.authToken.findFirst({
      where: { tokenHash: hash, type: "PASSWORD_RESET", usedAt: null, expiresAt: { gt: new Date() } },
    }));
    if (!tok || !tok.userId) throw new BadRequestException("Invalid or expired reset link");
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await runUnscoped(() => this.prisma.$transaction([
      this.prisma.user.update({ where: { id: tok.userId! }, data: { passwordHash } }),
      this.prisma.authToken.update({ where: { id: tok.id }, data: { usedAt: new Date() } }),
    ]));
  }
}
```
- [ ] **Step 4: Add controller routes.** In `apps/api/src/auth/auth.controller.ts` add (import `Throttle`, `ZodValidationPipe`, the schemas, `PasswordResetService`):
```ts
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Public()
  @Post("forgot-password")
  async forgot(@Body(new ZodValidationPipe(ForgotPasswordSchema)) body: ForgotPasswordInput) {
    await this.reset.requestReset(body.email); // ignore return; never leak existence
    return { status: "ok" };
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Public()
  @Post("reset-password")
  async resetPassword(@Body(new ZodValidationPipe(ResetPasswordSchema)) body: ResetPasswordInput) {
    await this.reset.reset(body.token, body.newPassword);
    return { status: "ok" };
  }
```
Inject `private readonly reset: PasswordResetService` into `AuthController`'s constructor, and add `PasswordResetService` to `AuthModule` providers.
- [ ] **Step 5:** `pnpm --filter @stello/api test password-reset && pnpm --filter @stello/api build` → PASS + build.
- [ ] **Step 6: Commit** — `git add apps/api/src/account apps/api/src/auth apps/api/test/password-reset.test.ts && git commit -m "feat(auth): password reset (forgot + reset) via email seam, no enumeration"`

---

### Task 5: Staff invites

**Files:** Create `apps/api/src/account/invites.service.ts`, `apps/api/src/account/invites.controller.ts`, `apps/api/src/account/account.module.ts`; modify `apps/api/src/app.module.ts`; Test `apps/api/test/invites.test.ts`.

**Interfaces — Produces:** `GET /tenant/roles`, `POST /tenant/invites` (owner), `POST /invite/accept` (public). Register `AccountModule` (imports `ProvisioningModule`? no — invites don't provision; just needs Prisma + EmailProvider which are global).

- [ ] **Step 1: Failing test** — `apps/api/test/invites.test.ts`:
```ts
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
```
- [ ] **Step 2: Run to fail** — `pnpm --filter @stello/api test invites` → FAIL.
- [ ] **Step 3: Implement service.** Create `apps/api/src/account/invites.service.ts`:
```ts
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import type { AuthUser, CreateInviteInput, AcceptInviteInput } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { EMAIL_PROVIDER, type EmailProvider } from "../email/email.provider";
import { newToken, hashToken } from "../common/token";
import { runUnscoped } from "../common/tenant-context";

const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const APP_URL = () => process.env.PUBLIC_APP_URL ?? "https://kitchens.stellotechs.com";

@Injectable()
export class InvitesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  async roles(user: AuthUser) {
    const roles = await this.prisma.role.findMany({ where: { tenantId: user.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } });
    return roles;
  }

  async create(user: AuthUser, input: CreateInviteInput): Promise<{ inviteLink: string; raw: string }> {
    const role = await this.prisma.role.findFirst({ where: { id: input.roleId, tenantId: user.tenantId }, select: { id: true } });
    if (!role) throw new NotFoundException("Role not found");
    const existing = await this.prisma.user.findFirst({ where: { tenantId: user.tenantId, email: input.email }, select: { id: true } });
    if (existing) throw new ConflictException("That email is already a user in this restaurant");
    const brand = await this.prisma.brand.findFirst({ where: { tenantId: user.tenantId }, select: { name: true } });
    const { raw, hash } = newToken();
    await this.prisma.authToken.create({
      data: { type: "INVITE", tenantId: user.tenantId, roleId: role.id, email: input.email, tokenHash: hash, expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
    });
    const link = `${APP_URL()}/invite/accept?token=${raw}`;
    await this.email.sendInvite(input.email, link, brand?.name ?? "the team");
    return { inviteLink: link, raw };
  }

  async accept(rawToken: string, input: AcceptInviteInput): Promise<{ user: { id: string; email: string; tenantId: string } }> {
    const hash = hashToken(rawToken);
    const tok = await runUnscoped(() => this.prisma.authToken.findFirst({
      where: { tokenHash: hash, type: "INVITE", usedAt: null, expiresAt: { gt: new Date() } },
    }));
    if (!tok || !tok.tenantId || !tok.roleId || !tok.email) throw new BadRequestException("Invalid or expired invite");
    const passwordHash = await bcrypt.hash(input.password, 10);
    const outlets = await runUnscoped(() => this.prisma.outlet.findMany({ where: { tenantId: tok.tenantId! }, select: { id: true } }));
    const user = await runUnscoped(() => this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          tenantId: tok.tenantId!, email: tok.email!, passwordHash, name: input.name, roleId: tok.roleId!, emailVerified: true,
          userOutlets: { create: outlets.map((o) => ({ outletId: o.id })) },
        },
      });
      await tx.authToken.update({ where: { id: tok.id }, data: { usedAt: new Date() } });
      return u;
    }));
    return { user: { id: user.id, email: user.email, tenantId: user.tenantId } };
  }
}
```
- [ ] **Step 4: Controller + module.** Create `apps/api/src/account/invites.controller.ts` with `GET /tenant/roles` + `POST /tenant/invites` (both `@RequirePermission("settings.manage")`, `@CurrentUser()`) and a separate `@Controller("invite")` `POST accept` (`@Public()`, `@Throttle({default:{limit:10,ttl:60000}})`), using `ZodValidationPipe`. The accept handler also issues a JWT (inject `JwtService`, sign `{ sub: user.id, tenantId: user.tenantId }`) and returns `{ accessToken, user }`. Create `apps/api/src/account/account.module.ts` providing `InvitesService` + `PasswordResetService` and declaring the controllers; import it in `app.module.ts`. (JwtModule is global, so `JwtService` injects.)
Provide the exact controller in this step's code block:
```ts
import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { JwtService } from "@nestjs/jwt";
import { CreateInviteSchema, AcceptInviteSchema, type AuthUser, type CreateInviteInput, type AcceptInviteInput } from "@stello/shared";
import { InvitesService } from "./invites.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { CurrentUser, Public, RequirePermission } from "../common/decorators";

@Controller("tenant")
export class InvitesController {
  constructor(private readonly svc: InvitesService) {}
  @RequirePermission("settings.manage")
  @Get("roles")
  roles(@CurrentUser() user: AuthUser) { return this.svc.roles(user); }
  @RequirePermission("settings.manage")
  @Post("invites")
  create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(CreateInviteSchema)) body: CreateInviteInput) {
    return this.svc.create(user, body).then((r) => ({ inviteLink: r.inviteLink }));
  }
}

@Controller("invite")
export class InviteAcceptController {
  constructor(private readonly svc: InvitesService, private readonly jwt: JwtService) {}
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post("accept")
  async accept(@Body(new ZodValidationPipe(AcceptInviteSchema)) body: AcceptInviteInput) {
    const { user } = await this.svc.accept(body.token, body);
    const accessToken = await this.jwt.signAsync({ sub: user.id, tenantId: user.tenantId });
    return { accessToken, user };
  }
}
```
- [ ] **Step 5:** `pnpm --filter @stello/api test invites && pnpm --filter @stello/api build` → PASS + build.
- [ ] **Step 6: Commit** — `git add apps/api/src/account apps/api/src/app.module.ts apps/api/test/invites.test.ts && git commit -m "feat(account): staff invites (owner-gated create + public accept)"`

---

### Task 6: Public signup (flag-gated)

**Files:** Create `apps/api/src/account/signup.service.ts`, `apps/api/src/account/signup.controller.ts`; modify `account.module.ts`; Test `apps/api/test/signup.test.ts`.

**Interfaces — Consumes:** `ProvisioningService` (import `ProvisioningModule` into `AccountModule`), `EMAIL_PROVIDER`, tokens, `JwtService`. **Produces:** `POST /signup`, `POST /signup/verify` (both `@Public`, gated).

- [ ] **Step 1: Failing test** — `apps/api/test/signup.test.ts` exercises the SERVICE directly (flag independent):
```ts
import { expect, it } from "vitest";
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
  expect(await testPrisma.pendingSignup.count({ where: { email: "ava@x.com" } })).toBe(0); // consumed
});
it("rejects duplicate email and invalid/expired token", async () => {
  await svc().start({ restaurantName: "R", ownerName: "O", email: "dupe@x.com", password: "secret12" });
  await expect(svc().start({ restaurantName: "R2", ownerName: "O2", email: "dupe@x.com", password: "secret12" })).rejects.toThrow();
  await expect(svc().verify("not-a-real-token")).rejects.toThrow();
});
```
- [ ] **Step 2: Run to fail** — `pnpm --filter @stello/api test signup` → FAIL.
- [ ] **Step 3: Implement service.** Create `apps/api/src/account/signup.service.ts`:
```ts
import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import type { SignupInput } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { ProvisioningService } from "../provisioning/provisioning.service";
import { EMAIL_PROVIDER, type EmailProvider } from "../email/email.provider";
import { newToken, hashToken } from "../common/token";
import { runUnscoped } from "../common/tenant-context";

const SIGNUP_TTL_MS = 24 * 60 * 60 * 1000;
const APP_URL = () => process.env.PUBLIC_APP_URL ?? "https://kitchens.stellotechs.com";

@Injectable()
export class SignupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provisioning: ProvisioningService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  /** Returns the raw token for TESTS; the controller emails it and responds generically. */
  async start(input: SignupInput): Promise<string> {
    const existingUser = await runUnscoped(() => this.prisma.user.findUnique({ where: { email: input.email }, select: { id: true } }));
    if (existingUser) throw new ConflictException("An account with this email already exists");
    const { raw, hash } = newToken();
    const passwordHash = await bcrypt.hash(input.password, 10);
    await runUnscoped(() => this.prisma.pendingSignup.upsert({
      where: { email: input.email },
      create: { email: input.email, passwordHash, restaurantName: input.restaurantName, ownerName: input.ownerName, tokenHash: hash, expiresAt: new Date(Date.now() + SIGNUP_TTL_MS) },
      update: { passwordHash, restaurantName: input.restaurantName, ownerName: input.ownerName, tokenHash: hash, expiresAt: new Date(Date.now() + SIGNUP_TTL_MS) },
    }));
    await this.email.sendVerification(input.email, `${APP_URL()}/signup/verify?token=${raw}`);
    return raw;
  }

  async verify(rawToken: string): Promise<{ tenantId: string; ownerId: string; email: string }> {
    const hash = hashToken(rawToken);
    const pending = await runUnscoped(() => this.prisma.pendingSignup.findFirst({ where: { tokenHash: hash, expiresAt: { gt: new Date() } } }));
    if (!pending) throw new BadRequestException("Invalid or expired verification link");
    // Provisioning hashes a password again; pass a throwaway then overwrite with the stored hash,
    // OR extend provisionTenant to accept a pre-hashed password. Here: create via engine, then set the stored hash.
    const res = await this.provisioning.provisionTenant({
      restaurantName: pending.restaurantName, ownerName: pending.ownerName, ownerEmail: pending.email,
      ownerPassword: rawToken, createdVia: "SIGNUP", // placeholder password; overwritten next line
    });
    await runUnscoped(() => this.prisma.$transaction([
      this.prisma.user.update({ where: { id: res.ownerId }, data: { passwordHash: pending.passwordHash } }),
      this.prisma.pendingSignup.delete({ where: { id: pending.id } }),
    ]));
    return { tenantId: res.tenantId, ownerId: res.ownerId, email: pending.email };
  }
}
```
> Note: the engine re-hashes a password; we store the user's already-hashed password from `PendingSignup` by overwriting `passwordHash` right after provisioning (both inside `runUnscoped`). The throwaway `ownerPassword: rawToken` satisfies the engine's min-length and is immediately replaced. (If preferred, extend `provisionTenant` to accept `ownerPasswordHash` — but keep this task's change local; the overwrite is correct and covered by the test asserting the owner can... — the test asserts email/consumption; add a bcrypt-compare assertion if extending.)
- [ ] **Step 4: Controller (gated).** Create `apps/api/src/account/signup.controller.ts` — `@Controller()` with `POST signup` and `POST signup/verify`, both `@Public()` + `@Throttle`. Each handler first checks `process.env.SIGNUP_PUBLIC_ENABLED === "true"`, else `throw new NotFoundException()`. `signup` calls `start` and returns `{ status: "verification_sent" }` (never the token). `verify` calls `verify`, then signs a JWT for the new owner and returns `{ accessToken, user }` (fetch the AuthUser via `AuthService.resolveUser(ownerId)` — inject `AuthService`; it's exported from AuthModule, so import AuthModule into AccountModule). Add `ProvisioningModule` + `AuthModule` to `AccountModule` imports; add `SignupService` to providers and the controller to controllers.
- [ ] **Step 5:** `pnpm --filter @stello/api test signup && pnpm --filter @stello/api build` → PASS + build.
- [ ] **Step 6: Commit** — `git add apps/api/src/account apps/api/test/signup.test.ts && git commit -m "feat(account): public signup (verify-then-create), flag-gated"`

---

### Task 7: e2e — public flows over HTTP

**Files:** Test `apps/api/test/account.e2e.test.ts`.

- [ ] **Step 1: Write e2e** — boot `AppModule` (pattern from `platform.e2e.test.ts`), set `process.env.SIGNUP_PUBLIC_ENABLED = "true"` before `app.init()`. Assert:
  - `POST /api/v1/signup` (valid body) → 200 `{status:"verification_sent"}`; the tenant does NOT exist yet. Read the verification token from the DB (`pendingSignup.tokenHash` can't be reversed — instead capture it by making the LoggingEmailProvider’s log unnecessary: query `pending_signups` for the row and, since we can't get the raw token from the hash, drive verify via the SERVICE using a raw token you generate is not possible over HTTP). **Approach:** for the e2e, override `EMAIL_PROVIDER` with a capturing fake via `overrideProvider(EMAIL_PROVIDER).useValue({...})` that records the `link` passed to `sendVerification`; extract `?token=` from it; then `POST /api/v1/signup/verify {token}` → 200 with `accessToken`.
  - With `SIGNUP_PUBLIC_ENABLED` unset/false (a second describe or a beforeAll toggling env + rebuilding the app) → `POST /api/v1/signup` → 404.
  - `POST /api/v1/auth/forgot-password {email: unknown}` → 200 (generic).
- [ ] **Step 2: Run** — `pnpm --filter @stello/api test account.e2e` → PASS.
- [ ] **Step 3: Full suite + commit** — `pnpm --filter @stello/api test` all green → `git add apps/api/test/account.e2e.test.ts && git commit -m "test(account): e2e signup verify + flag-off 404 + forgot-password generic"`

---

### Task 8: Frontend API client methods

**Files:** Modify `apps/dashboard/lib/api.ts`; Modify `packages/shared` import usage as needed.

- [ ] **Step 1:** Add to the `api` object (matching the existing `request()` convention):
```ts
  signup: (body: { restaurantName: string; ownerName: string; email: string; password: string }) =>
    request<{ status: string }>("/signup", { method: "POST", body: JSON.stringify(body) }),
  verifySignup: (token: string) =>
    request<{ accessToken: string; user: unknown }>("/signup/verify", { method: "POST", body: JSON.stringify({ token }) }),
  forgotPassword: (email: string) =>
    request<{ status: string }>("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) }),
  resetPassword: (token: string, newPassword: string) =>
    request<{ status: string }>("/auth/reset-password", { method: "POST", body: JSON.stringify({ token, newPassword }) }),
  tenantRoles: () => request<{ id: string; name: string }[]>("/tenant/roles"),
  createInvite: (email: string, roleId: string) =>
    request<{ inviteLink: string }>("/tenant/invites", { method: "POST", body: JSON.stringify({ email, roleId }) }),
  acceptInvite: (token: string, name: string, password: string) =>
    request<{ accessToken: string; user: unknown }>("/invite/accept", { method: "POST", body: JSON.stringify({ token, name, password }) }),
```
(Confirm the `verifySignup`/`acceptInvite` return-type shape against `LoginResponse` in `@stello/shared` and type them accordingly.)
- [ ] **Step 2:** `pnpm --filter @stello/dashboard exec tsc --noEmit` → clean.
- [ ] **Step 3: Commit** — `git add apps/dashboard/lib/api.ts && git commit -m "feat(dashboard): account-lifecycle API client methods"`

---

### Task 9: Public auth pages — forgot/reset + login link

**Files:** Create `apps/dashboard/app/forgot-password/page.tsx`, `apps/dashboard/app/reset-password/page.tsx`; modify `apps/dashboard/app/login/page.tsx` (add link); styles as needed in `globals.css`.

- [ ] **Step 1: Build the pages** (mirror the `/login` page pattern — client component, own form, uses `api`, no Shell):
  - `/forgot-password`: email input → `api.forgotPassword(email)` → always show "If that email exists, a reset link has been sent." (generic).
  - `/reset-password`: read `?token` (`useSearchParams`), new-password input → `api.resetPassword(token, pw)` → success → link to `/login`.
  - `/login`: add a `<a href="/forgot-password">Forgot password?</a>` link.
  - Disable buttons while pending; show errors via the existing `.form-error` pattern.
- [ ] **Step 2:** `pnpm --filter @stello/dashboard exec tsc --noEmit && pnpm --filter @stello/dashboard build` → clean + build.
- [ ] **Step 3: Commit** — `git add apps/dashboard/app/forgot-password apps/dashboard/app/reset-password apps/dashboard/app/login apps/dashboard/app/globals.css && git commit -m "feat(dashboard): forgot-password + reset-password pages + login link"`

---

### Task 10: Public signup + verify pages

**Files:** Create `apps/dashboard/app/signup/page.tsx`, `apps/dashboard/app/signup/verify/page.tsx`.

- [ ] **Step 1: Build** (mirror `/login`):
  - `/signup`: restaurantName, ownerName, email, password → `api.signup(...)` → "check your email" state. (The page can always render; the backend 404s when the flag is off — show a friendly "signup isn't open yet" if the call 404s.)
  - `/signup/verify`: read `?token` → `api.verifySignup(token)` on mount → on success, store the token via the session (`useSession().` login-by-token, or set `stello.token` in localStorage + `refresh()`), then `router.replace("/onboarding")`. If the session has no direct token-setter, add a minimal `setToken`/`refresh` path (read how `SessionProvider` stores the token from `login()` and reuse it).
- [ ] **Step 2:** `pnpm --filter @stello/dashboard exec tsc --noEmit && pnpm --filter @stello/dashboard build` → clean + build.
- [ ] **Step 3: Commit** — `git add apps/dashboard/app/signup && git commit -m "feat(dashboard): public signup + email-verify pages"`

---

### Task 11: Invite-accept page + Console invite panel

**Files:** Create `apps/dashboard/app/invite/accept/page.tsx`; create `apps/dashboard/components/console/InviteStaffTab.tsx` (or add to an existing settings/console area — confirm where Console tabs live and follow that); wire it into the Console tab list.

- [ ] **Step 1: Build**:
  - `/invite/accept`: read `?token`, name + password inputs → `api.acceptInvite(token,name,pw)` → store token in session → `router.replace("/")` (routes to their surface).
  - Console **Invite staff** panel: `api.tenantRoles()` to populate a role `<select>`, email input → `api.createInvite(email, roleId)` → display the returned `inviteLink` with a copy button. Follow the existing Console tab styling + error pattern.
- [ ] **Step 2:** `pnpm --filter @stello/dashboard exec tsc --noEmit && pnpm --filter @stello/dashboard build` → clean + build.
- [ ] **Step 3: Commit** — `git add apps/dashboard/app/invite apps/dashboard/components && git commit -m "feat(dashboard): invite-accept page + Console invite-staff panel"`

---

## Manual/run verification (after all tasks)

With the stack local (`docker compose up -d`, `pnpm dev:api` with `SIGNUP_PUBLIC_ENABLED=true` + `PUBLIC_APP_URL=http://localhost:3002`, dashboard dev):
1. **Signup:** `/signup` → submit → read the `[verify]` link from the API logs → open it → land in onboarding for a brand-new tenant.
2. **Reset:** `/forgot-password` → submit for a real user → read the `[reset]` link from logs → set a new password → log in with it.
3. **Invite:** log in as an owner → Console → Invite staff → create an invite → copy the returned link → open `/invite/accept` in another browser → set password → confirm the new user logs into their surface with the right role.
4. Flag off (`SIGNUP_PUBLIC_ENABLED` unset): `/signup` submit → friendly "not open yet".

## Self-review (coverage vs spec)

- Email seam + tokens → Tasks 2–3. ✓
- Password reset (no enumeration; link never returned) → Task 4 (+ e2e forgot generic in Task 7). ✓
- Staff invites (owner-gated, cross-tenant role rejected, link returned) → Task 5. ✓
- Public signup (verify-then-create, flag-gated) → Task 6 (+ e2e Task 7). ✓
- Frontend pages + login link + Console panel → Tasks 8–11. ✓
- Security (throttle, hashed single-use tokens, gating) → Global Constraints + per-task. ✓
- Out of scope (real vendor, billing, 2FA) → absent. ✓
