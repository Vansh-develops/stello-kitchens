# Tenant Provisioning — Phase 1: Engine & Admin Path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a shared provisioning engine that atomically creates a complete tenant, exposed through a platform super-admin API, so real restaurants can be created without editing the seed script.

**Architecture:** A `ProvisioningService` runs one Prisma transaction **unscoped** (bypassing the tenant-scope extension via the existing `runUnscoped()`) to create Tenant → Brand → standard roles → first Outlet → Owner user → AuditLog. A `PlatformAdminGuard` gates a `PlatformController` (`/platform/tenants`) that calls the engine. A one-shot script bootstraps the first super-admin.

**Tech Stack:** NestJS 11, Prisma 6 / PostgreSQL 16, TypeScript 5.8, pnpm workspaces, Zod (validation), bcryptjs, vitest (new to the API in Task 1).

**Scope note:** This is Phase 1 of the spec `docs/superpowers/specs/2026-07-11-tenant-provisioning-onboarding-design.md`. Phase 2 (onboarding wizard + supporting endpoints) and Phase 3 (public signup + email seam) get their own plans. This phase's migration adds ONLY the fields it uses; `PendingSignup` and `AuthToken` are deferred to their phases.

## Global Constraints

- TypeScript 5.8; NestJS 11; Prisma 6.8; pnpm 10.33 workspaces. Run all pnpm commands from the repo root with `--filter`.
- Multi-tenant isolation is sacred: provisioning MUST run inside `runUnscoped(() => prisma.$transaction(...))` so it never inherits a caller's tenant context. Every created row carries an explicit `tenantId`.
- Standard roles created for every tenant MUST mirror the seed exactly: Owner `["*"]`, Cashier `["orders.create","orders.settle","menu.stock"]`, Kitchen `["kds.operate","menu.stock"]` (`apps/api/prisma/seed.ts:44-61`).
- Passwords hashed with `bcryptjs` at cost 10 (matches `seed.ts:63`).
- Trial length default: 14 days. Tenant `createdVia` = `ADMIN` on this path.
- Admin path requires an `ownerPassword` in Phase 1 (the passwordless/invite variant arrives with the invite infra in Phase 2). 
- Prerequisite for running tests: the dev Postgres must be up — `docker compose up -d postgres` (root `docker-compose.yml`, binds `127.0.0.1:5455`, user/pw/db `stello`).

---

### Task 1: API test harness (vitest + real test database)

The API has no tests today. Provisioning is data-heavy, so tests run against a real throwaway Postgres database, not mocks.

**Files:**
- Create: `apps/api/vitest.config.ts`
- Create: `apps/api/test/db.ts`
- Create: `apps/api/test/harness.test.ts`
- Modify: `apps/api/package.json` (add `test` script + devDeps)

**Interfaces:**
- Produces: `resetDb(): Promise<void>` and `testPrisma: PrismaClient` (raw, test-DB-pointed) from `apps/api/test/db.ts`, used by later tasks' tests.

- [ ] **Step 1: Add vitest + supertest devDeps and a test script**

Run:
```bash
pnpm --filter @stello/api add -D vitest @types/supertest supertest
```
Then edit `apps/api/package.json` to add under `"scripts"`:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 2: Create the vitest config**

Create `apps/api/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    fileParallelism: false, // shared test DB — run files serially
    hookTimeout: 60000,
    testTimeout: 30000,
    setupFiles: ["test/db.ts"],
  },
});
```

- [ ] **Step 3: Create the test-DB helper (schema push + reset)**

Create `apps/api/test/db.ts`:
```ts
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { beforeAll, beforeEach } from "vitest";

// A dedicated throwaway database on the dev Postgres (port 5455).
const TEST_URL =
  process.env.DATABASE_URL_TEST ??
  "postgresql://stello:stello@localhost:5455/stello_test?schema=public";
process.env.DATABASE_URL = TEST_URL;

export const testPrisma = new PrismaClient({ datasources: { db: { url: TEST_URL } } });

beforeAll(() => {
  // Create the DB if missing, then push the current schema to it.
  execSync(
    `docker exec stello-postgres psql -U stello -tc "SELECT 1 FROM pg_database WHERE datname='stello_test'" | grep -q 1 || docker exec stello-postgres createdb -U stello stello_test`,
    { stdio: "ignore", shell: "/bin/bash" },
  );
  execSync("pnpm --filter @stello/api exec prisma db push --skip-generate --accept-data-loss", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: TEST_URL },
  });
});

// Truncate every table between tests for isolation.
export async function resetDb(): Promise<void> {
  const rows = await testPrisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  if (list) await testPrisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

beforeEach(async () => {
  await resetDb();
});
```

- [ ] **Step 4: Write the harness smoke test**

Create `apps/api/test/harness.test.ts`:
```ts
import { expect, it } from "vitest";
import { testPrisma } from "./db";

it("connects to the test database and starts empty", async () => {
  const tenants = await testPrisma.tenant.count();
  expect(tenants).toBe(0);
});
```

- [ ] **Step 5: Run it**

Run: `docker compose up -d postgres && pnpm --filter @stello/api test`
Expected: PASS (1 test). If it errors on `docker exec stello-postgres`, confirm the dev postgres container name with `docker ps`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/vitest.config.ts apps/api/test/ apps/api/package.json pnpm-lock.yaml
git commit -m "test(api): add vitest harness backed by a throwaway test database"
```

---

### Task 2: Schema migration — tenant lifecycle + platform-admin fields

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (Tenant, User models; add two enums)
- Create: migration under `apps/api/prisma/migrations/`
- Test: `apps/api/test/schema.test.ts`

**Interfaces:**
- Produces: `Tenant.status/trialEndsAt/onboardedAt/createdVia`, `User.isPlatformAdmin/emailVerified`, enums `TenantStatus`, `TenantOrigin` — consumed by the engine (Task 5) and auth (Task 4).

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/schema.test.ts`:
```ts
import { expect, it } from "vitest";
import { testPrisma } from "./db";

it("stores tenant lifecycle + platform-admin fields", async () => {
  const tenant = await testPrisma.tenant.create({
    data: { name: "T", status: "TRIAL", createdVia: "ADMIN", trialEndsAt: new Date() },
  });
  expect(tenant.status).toBe("TRIAL");
  expect(tenant.onboardedAt).toBeNull();

  const role = await testPrisma.role.create({
    data: { tenantId: tenant.id, name: "Owner", permissions: ["*"] },
  });
  const user = await testPrisma.user.create({
    data: {
      tenantId: tenant.id, email: "a@b.com", passwordHash: "x", name: "A",
      roleId: role.id, isPlatformAdmin: true, emailVerified: true,
    },
  });
  expect(user.isPlatformAdmin).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @stello/api test schema`
Expected: FAIL (TS/Prisma: `status`/`isPlatformAdmin` unknown).

- [ ] **Step 3: Edit the schema**

In `apps/api/prisma/schema.prisma`, add near the top (after the datasource):
```prisma
enum TenantStatus {
  TRIAL
  ACTIVE
  SUSPENDED
}

enum TenantOrigin {
  SEED
  ADMIN
  SIGNUP
}
```
Replace the `Tenant` model body with:
```prisma
model Tenant {
  id          String        @id @default(cuid())
  name        String
  status      TenantStatus  @default(TRIAL)
  trialEndsAt DateTime?
  onboardedAt DateTime?
  createdVia  TenantOrigin  @default(SEED)
  createdAt   DateTime      @default(now())

  brands Brand[]
  users  User[]
  roles  Role[]

  @@map("tenants")
}
```
In the `User` model, add these two fields (after `isActive`):
```prisma
  isPlatformAdmin Boolean @default(false)
  emailVerified   Boolean @default(false)
```

- [ ] **Step 4: Create and apply the migration**

Run:
```bash
pnpm --filter @stello/api exec prisma migrate dev --name tenant_lifecycle_platform_admin
```
Expected: migration created + applied to the dev DB, client regenerated.

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @stello/api test schema`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations apps/api/test/schema.test.ts
git commit -m "feat(db): tenant lifecycle status + platform-admin/email-verified fields"
```

---

### Task 3: Shared types + provisioning schema

**Files:**
- Modify: `packages/shared/src/types.ts` (AuthUser)
- Modify: `packages/shared/src/schemas.ts` (new schema)
- Test: `packages/shared/src/schemas.provisioning.test.ts`

**Interfaces:**
- Produces: `AuthUser.isPlatformAdmin: boolean`; `ProvisionTenantSchema` + `ProvisionTenantInput` (`{ restaurantName, ownerName, ownerEmail, ownerPassword }`) — consumed by Tasks 4 and 7.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/schemas.provisioning.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ProvisionTenantSchema } from "./schemas";

describe("ProvisionTenantSchema", () => {
  it("accepts a valid payload", () => {
    const r = ProvisionTenantSchema.safeParse({
      restaurantName: "Spice Route", ownerName: "Asha", ownerEmail: "a@b.com", ownerPassword: "secret12",
    });
    expect(r.success).toBe(true);
  });
  it("rejects a short password and a bad email", () => {
    expect(ProvisionTenantSchema.safeParse({
      restaurantName: "X", ownerName: "Y", ownerEmail: "nope", ownerPassword: "123",
    }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @stello/shared test`
Expected: FAIL (`ProvisionTenantSchema` not exported).

- [ ] **Step 3: Add the schema and type field**

Append to `packages/shared/src/schemas.ts`:
```ts
export const ProvisionTenantSchema = z.object({
  restaurantName: z.string().min(2).max(120),
  ownerName: z.string().min(1).max(120),
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(8).max(200),
});
export type ProvisionTenantInput = z.infer<typeof ProvisionTenantSchema>;
```
In `packages/shared/src/types.ts`, add to the `AuthUser` interface (after `outletIds`):
```ts
  isPlatformAdmin: boolean;
```

- [ ] **Step 4: Run the test + build shared**

Run: `pnpm --filter @stello/shared test && pnpm --filter @stello/shared build`
Expected: tests PASS; build emits `dist/`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/schemas.ts packages/shared/src/types.ts packages/shared/src/schemas.provisioning.test.ts
git commit -m "feat(shared): ProvisionTenantSchema + AuthUser.isPlatformAdmin"
```

---

### Task 4: Surface `isPlatformAdmin` through auth

**Files:**
- Modify: `apps/api/src/auth/auth.service.ts` (`toAuthUser`)
- Test: `apps/api/test/auth.test.ts`

**Interfaces:**
- Consumes: `AuthUser.isPlatformAdmin` (Task 3), User fields (Task 2).
- Produces: `AuthService.resolveUser()` now returns `isPlatformAdmin` — consumed by the guard (Task 6).

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/auth.test.ts`:
```ts
import { expect, it } from "vitest";
import { PrismaService } from "../src/prisma/prisma.service";
import { AuthService } from "../src/auth/auth.service";
import { JwtService } from "@nestjs/jwt";

it("resolveUser reflects isPlatformAdmin", async () => {
  const prisma = new PrismaService();
  const auth = new AuthService(prisma, new JwtService({ secret: "test" }));
  const tenant = await prisma.tenant.create({ data: { name: "T" } });
  const role = await prisma.role.create({ data: { tenantId: tenant.id, name: "Owner", permissions: ["*"] } });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, email: "p@a.com", passwordHash: "x", name: "P", roleId: role.id, isPlatformAdmin: true },
  });
  const resolved = await auth.resolveUser(user.id);
  expect(resolved.isPlatformAdmin).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @stello/api test auth`
Expected: FAIL (`resolved.isPlatformAdmin` is `undefined`).

- [ ] **Step 3: Update `toAuthUser`**

In `apps/api/src/auth/auth.service.ts`, change the `toAuthUser` parameter type to include the flag and return it. Update the signature's inline type to add `isPlatformAdmin: boolean;`, and add to the returned object:
```ts
      outletIds: user.userOutlets.map((uo) => uo.outletId),
      isPlatformAdmin: user.isPlatformAdmin,
```
(The `findUnique` calls in `login`/`resolveUser` already return all scalar fields, so `isPlatformAdmin` is present with no query change.)

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @stello/api test auth`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/auth.service.ts apps/api/test/auth.test.ts
git commit -m "feat(auth): expose isPlatformAdmin on the resolved user"
```

---

### Task 5: Provisioning engine

**Files:**
- Create: `apps/api/src/provisioning/provisioning.service.ts`
- Create: `apps/api/src/provisioning/provisioning.module.ts`
- Test: `apps/api/test/provisioning.service.test.ts`

**Interfaces:**
- Consumes: `PrismaService`, `runUnscoped` (`apps/api/src/common/tenant-context.ts`), `ProvisionTenantInput` (Task 3).
- Produces: `ProvisioningService.provisionTenant(input: { restaurantName; ownerName; ownerEmail; ownerPassword; createdVia: "ADMIN" | "SIGNUP" }): Promise<{ tenantId: string; ownerId: string }>` — consumed by the controller (Task 7).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/provisioning.service.test.ts`:
```ts
import { expect, it } from "vitest";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../src/prisma/prisma.service";
import { ProvisioningService } from "../src/provisioning/provisioning.service";
import { enterTenant } from "../src/common/tenant-context";

function svc() { return new ProvisioningService(new PrismaService()); }

it("creates the full tenant graph with matching tenantId and seed-parity roles", async () => {
  const prisma = new PrismaService();
  const service = new ProvisioningService(prisma);
  const { tenantId, ownerId } = await service.provisionTenant({
    restaurantName: "Spice Route", ownerName: "Asha", ownerEmail: "asha@x.com",
    ownerPassword: "secret12", createdVia: "ADMIN",
  });

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  expect(tenant?.status).toBe("TRIAL");
  expect(tenant?.createdVia).toBe("ADMIN");
  expect(tenant?.trialEndsAt).not.toBeNull();

  const roles = await prisma.role.findMany({ where: { tenantId } });
  const byName = Object.fromEntries(roles.map((r) => [r.name, r.permissions]));
  expect(byName["Owner"]).toEqual(["*"]);
  expect(byName["Cashier"]).toEqual(["orders.create", "orders.settle", "menu.stock"]);
  expect(byName["Kitchen"]).toEqual(["kds.operate", "menu.stock"]);

  const outlets = await prisma.outlet.findMany({ where: { tenantId } });
  expect(outlets).toHaveLength(1);

  const owner = await prisma.user.findUnique({ where: { id: ownerId }, include: { userOutlets: true } });
  expect(owner?.tenantId).toBe(tenantId);
  expect(owner?.emailVerified).toBe(true);
  expect(owner?.userOutlets).toHaveLength(1);
  expect(await bcrypt.compare("secret12", owner!.passwordHash)).toBe(true);
});

it("runs unscoped: ignores an ambient tenant context", async () => {
  // Simulate being called inside another tenant's request context.
  enterTenant("some-other-tenant-id");
  const { tenantId } = await svc().provisionTenant({
    restaurantName: "R2", ownerName: "B", ownerEmail: "b@x.com", ownerPassword: "secret12", createdVia: "ADMIN",
  });
  expect(tenantId).not.toBe("some-other-tenant-id");
  const owner = await new PrismaService().user.findFirst({ where: { email: "b@x.com" } });
  expect(owner?.tenantId).toBe(tenantId); // NOT the ambient id
});

it("rejects a duplicate owner email", async () => {
  const input = { restaurantName: "R", ownerName: "C", ownerEmail: "dupe@x.com", ownerPassword: "secret12", createdVia: "ADMIN" as const };
  await svc().provisionTenant(input);
  await expect(svc().provisionTenant(input)).rejects.toThrow();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @stello/api test provisioning.service`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the engine**

Create `apps/api/src/provisioning/provisioning.service.ts`:
```ts
import { ConflictException, Injectable } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";
import { runUnscoped } from "../common/tenant-context";

const TRIAL_DAYS = 14;

const STANDARD_ROLES = [
  { name: "Owner", permissions: ["*"] },
  { name: "Cashier", permissions: ["orders.create", "orders.settle", "menu.stock"] },
  { name: "Kitchen", permissions: ["kds.operate", "menu.stock"] },
];

export interface ProvisionInput {
  restaurantName: string;
  ownerName: string;
  ownerEmail: string;
  ownerPassword: string;
  createdVia: "ADMIN" | "SIGNUP";
  themeId?: string;
}

@Injectable()
export class ProvisioningService {
  constructor(private readonly prisma: PrismaService) {}

  async provisionTenant(input: ProvisionInput): Promise<{ tenantId: string; ownerId: string }> {
    const existing = await runUnscoped(() =>
      this.prisma.user.findUnique({ where: { email: input.ownerEmail }, select: { id: true } }),
    );
    if (existing) throw new ConflictException("An account with this email already exists");

    const passwordHash = await bcrypt.hash(input.ownerPassword, 10);
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    return runUnscoped(() =>
      this.prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: { name: input.restaurantName, status: "TRIAL", createdVia: input.createdVia, trialEndsAt },
        });
        await tx.brand.create({
          data: { tenantId: tenant.id, name: input.restaurantName, themeId: input.themeId ?? "counter" },
        });
        const roles = await Promise.all(
          STANDARD_ROLES.map((r) =>
            tx.role.create({ data: { tenantId: tenant.id, name: r.name, permissions: r.permissions } }),
          ),
        );
        const ownerRole = roles.find((r) => r.name === "Owner")!;
        const outlet = await tx.outlet.create({
          data: { tenantId: tenant.id, name: "Main Outlet" },
        });
        const owner = await tx.user.create({
          data: {
            tenantId: tenant.id, email: input.ownerEmail, passwordHash, name: input.ownerName,
            roleId: ownerRole.id, emailVerified: true,
            userOutlets: { create: [{ outletId: outlet.id }] },
          },
        });
        await tx.auditLog.create({
          data: { tenantId: tenant.id, userId: owner.id, action: "TENANT_CREATED", entity: "tenant", entityId: tenant.id },
        });
        return { tenantId: tenant.id, ownerId: owner.id };
      }),
    );
  }
}
```
Create `apps/api/src/provisioning/provisioning.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { ProvisioningService } from "./provisioning.service";

@Module({ providers: [ProvisioningService], exports: [ProvisioningService] })
export class ProvisioningModule {}
```

**Note:** confirm the `Outlet` create needs only `tenantId` + `name` (other columns must be nullable or defaulted). If `Outlet` has required columns without defaults, add them here with sensible defaults and update the test. Check with:
`awk '/^model Outlet \{/{f=1} f{print} /^\}/{if(f)exit}' apps/api/prisma/schema.prisma`

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @stello/api test provisioning.service`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/provisioning/ apps/api/test/provisioning.service.test.ts
git commit -m "feat(provisioning): unscoped engine that atomically creates a tenant"
```

---

### Task 6: PlatformAdminGuard

**Files:**
- Create: `apps/api/src/common/platform-admin.guard.ts`
- Test: `apps/api/test/platform-admin.guard.test.ts`

**Interfaces:**
- Consumes: `request.user.isPlatformAdmin` (set by the existing `JwtAuthGuard`).
- Produces: `PlatformAdminGuard` (a `CanActivate`) — used by the controller (Task 7).

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/platform-admin.guard.test.ts`:
```ts
import { expect, it } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { PlatformAdminGuard } from "../src/common/platform-admin.guard";

function ctx(user: unknown) {
  return { switchToHttp: () => ({ getRequest: () => ({ user }) }) } as any;
}

it("allows a platform admin", () => {
  expect(new PlatformAdminGuard().canActivate(ctx({ isPlatformAdmin: true }))).toBe(true);
});
it("denies a normal user", () => {
  expect(() => new PlatformAdminGuard().canActivate(ctx({ isPlatformAdmin: false }))).toThrow(ForbiddenException);
});
it("denies when there is no user", () => {
  expect(() => new PlatformAdminGuard().canActivate(ctx(undefined))).toThrow(ForbiddenException);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @stello/api test platform-admin.guard`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the guard**

Create `apps/api/src/common/platform-admin.guard.ts`:
```ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";

/**
 * Allows only platform super-admins. Runs after the global JwtAuthGuard, which
 * has already populated request.user (including isPlatformAdmin) from the DB.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest().user;
    if (!user?.isPlatformAdmin) throw new ForbiddenException("Platform admin only");
    return true;
  }
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @stello/api test platform-admin.guard`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/common/platform-admin.guard.ts apps/api/test/platform-admin.guard.test.ts
git commit -m "feat(auth): PlatformAdminGuard for cross-tenant admin routes"
```

---

### Task 7: Platform controller (`/platform/tenants`)

**Files:**
- Create: `apps/api/src/provisioning/platform.controller.ts`
- Modify: `apps/api/src/provisioning/provisioning.module.ts` (register controller)
- Modify: `apps/api/src/app.module.ts` (import ProvisioningModule)
- Test: `apps/api/test/platform.controller.test.ts`

**Interfaces:**
- Consumes: `ProvisioningService` (Task 5), `PlatformAdminGuard` (Task 6), `ProvisionTenantSchema` (Task 3), `ZodValidationPipe` (`apps/api/src/common/zod.pipe.ts`).
- Produces: `POST /platform/tenants` → `{ tenantId, ownerId }`; `GET /platform/tenants` → summary list.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/platform.controller.test.ts`:
```ts
import { expect, it } from "vitest";
import { PrismaService } from "../src/prisma/prisma.service";
import { ProvisioningService } from "../src/provisioning/provisioning.service";
import { PlatformController } from "../src/provisioning/platform.controller";

it("creates a tenant and lists it", async () => {
  const prisma = new PrismaService();
  const ctrl = new PlatformController(new ProvisioningService(prisma), prisma);
  const res = await ctrl.create({
    restaurantName: "Spice Route", ownerName: "Asha", ownerEmail: "a@x.com", ownerPassword: "secret12",
  });
  expect(res.tenantId).toBeTruthy();
  const list = await ctrl.list();
  expect(list.find((t) => t.id === res.tenantId)?.name).toBe("Spice Route");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @stello/api test platform.controller`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the controller + wire the module**

Create `apps/api/src/provisioning/platform.controller.ts`:
```ts
import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ProvisionTenantSchema, type ProvisionTenantInput } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { ProvisioningService } from "./provisioning.service";
import { ZodValidationPipe } from "../common/zod.pipe";
import { PlatformAdminGuard } from "../common/platform-admin.guard";
import { runUnscoped } from "../common/tenant-context";

@Controller("platform")
@UseGuards(PlatformAdminGuard)
export class PlatformController {
  constructor(
    private readonly provisioning: ProvisioningService,
    private readonly prisma: PrismaService,
  ) {}

  @Post("tenants")
  create(@Body(new ZodValidationPipe(ProvisionTenantSchema)) body: ProvisionTenantInput) {
    return this.provisioning.provisionTenant({ ...body, createdVia: "ADMIN" });
  }

  @Get("tenants")
  list() {
    return runUnscoped(() =>
      this.prisma.tenant.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          id: true, name: true, status: true, createdVia: true, createdAt: true, onboardedAt: true,
          _count: { select: { users: true, brands: true } },
        },
      }),
    );
  }
}
```
Update `apps/api/src/provisioning/provisioning.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { ProvisioningService } from "./provisioning.service";
import { PlatformController } from "./platform.controller";

@Module({
  controllers: [PlatformController],
  providers: [ProvisioningService],
  exports: [ProvisioningService],
})
export class ProvisioningModule {}
```
In `apps/api/src/app.module.ts`, add the import and list it in `imports` (next to the other feature modules):
```ts
import { ProvisioningModule } from "./provisioning/provisioning.module";
```
```ts
    ProvisioningModule,
```

- [ ] **Step 4: Run the test + full API build**

Run: `pnpm --filter @stello/api test platform.controller && pnpm --filter @stello/api build`
Expected: test PASS; `nest build` succeeds (guard is applied globally-after-Jwt because `JwtAuthGuard` is the APP_GUARD and `@UseGuards(PlatformAdminGuard)` runs after it).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/provisioning/ apps/api/src/app.module.ts apps/api/test/platform.controller.test.ts
git commit -m "feat(provisioning): POST/GET /platform/tenants behind PlatformAdminGuard"
```

---

### Task 8: Platform-admin bootstrap script

**Files:**
- Create: `apps/api/prisma/provision-platform-admin.ts`
- Modify: `apps/api/package.json` (add `provision:platform-admin` script)
- Test: `apps/api/test/bootstrap-admin.test.ts`

**Interfaces:**
- Consumes: an existing user's email (arg or `PLATFORM_ADMIN_EMAIL`).
- Produces: sets `isPlatformAdmin = true`. Exposes `promotePlatformAdmin(prisma, email): Promise<boolean>` for the test.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/bootstrap-admin.test.ts`:
```ts
import { expect, it } from "vitest";
import { testPrisma } from "./db";
import { promotePlatformAdmin } from "../prisma/provision-platform-admin";

it("promotes an existing user to platform admin", async () => {
  const tenant = await testPrisma.tenant.create({ data: { name: "T" } });
  const role = await testPrisma.role.create({ data: { tenantId: tenant.id, name: "Owner", permissions: ["*"] } });
  await testPrisma.user.create({
    data: { tenantId: tenant.id, email: "boss@x.com", passwordHash: "x", name: "Boss", roleId: role.id },
  });
  const ok = await promotePlatformAdmin(testPrisma, "boss@x.com");
  expect(ok).toBe(true);
  const u = await testPrisma.user.findUnique({ where: { email: "boss@x.com" } });
  expect(u?.isPlatformAdmin).toBe(true);
});

it("returns false for an unknown email", async () => {
  expect(await promotePlatformAdmin(testPrisma, "ghost@x.com")).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @stello/api test bootstrap-admin`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the script**

Create `apps/api/prisma/provision-platform-admin.ts`:
```ts
import { PrismaClient } from "@prisma/client";

export async function promotePlatformAdmin(prisma: PrismaClient, email: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return false;
  await prisma.user.update({ where: { id: user.id }, data: { isPlatformAdmin: true } });
  return true;
}

// CLI entry: `pnpm --filter @stello/api provision:platform-admin <email>`
// Falls back to PLATFORM_ADMIN_EMAIL.
async function main() {
  const email = process.argv[2] ?? process.env.PLATFORM_ADMIN_EMAIL;
  if (!email) {
    console.error("Usage: provision:platform-admin <email>  (or set PLATFORM_ADMIN_EMAIL)");
    process.exit(1);
  }
  const prisma = new PrismaClient();
  const ok = await promotePlatformAdmin(prisma, email);
  await prisma.$disconnect();
  console.log(ok ? `Promoted ${email} to platform admin.` : `No user found for ${email}.`);
  process.exit(ok ? 0 : 1);
}

// Run only when invoked directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith("provision-platform-admin.ts")) void main();
```
Add to `apps/api/package.json` scripts:
```json
"provision:platform-admin": "ts-node prisma/provision-platform-admin.ts"
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @stello/api test bootstrap-admin`
Expected: PASS (2 tests).

- [ ] **Step 5: Full test sweep + commit**

Run: `pnpm --filter @stello/api test && pnpm --filter @stello/shared test`
Expected: all PASS.
```bash
git add apps/api/prisma/provision-platform-admin.ts apps/api/package.json apps/api/test/bootstrap-admin.test.ts
git commit -m "feat(provisioning): platform-admin bootstrap script"
```

---

## Manual verification (after all tasks)

With the stack running locally (`docker compose up -d` + `pnpm dev:api`):
1. Seed or create a user, then `pnpm --filter @stello/api provision:platform-admin admin@demo.com`.
2. Log in as that user, capture the JWT.
3. `POST /api/v1/platform/tenants` with the JWT and a body → expect `{ tenantId, ownerId }`.
4. Log in with the new owner's email/password → confirm they land in their own empty tenant.
5. As a non-admin JWT, `POST /api/v1/platform/tenants` → expect `403`.

## Self-review notes (coverage vs spec)

- Spec §"Provisioning engine" → Task 5 (unscoped, seed-parity roles, atomic). ✓
- Spec §"Path A — Admin provisioning" → Tasks 6–7 (guard + controller). ownerPassword required in Phase 1 per Global Constraints; invite variant deferred to Phase 2. ✓ (documented deviation)
- Spec §"Data model" → Task 2 covers Tenant/User fields + enums used in Phase 1; `PendingSignup`/`AuthToken` intentionally deferred to Phases 3/2. ✓
- Spec §"Bootstrap" → Task 8. ✓
- Spec §"Shared types" (`AuthUser.isPlatformAdmin`) → Tasks 3–4. ✓
- Deferred to later plans: EmailProvider seam, public signup, onboarding wizard, supporting endpoints (outlet PATCH, menu template, invites, tables), password-reset. Tracked in the spec's Rollout §.
