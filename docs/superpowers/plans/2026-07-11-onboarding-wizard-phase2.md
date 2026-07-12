# Onboarding Wizard (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A first-run onboarding wizard that takes a freshly-provisioned owner from an empty account to a usable POS (configured outlet, a menu, tables with QR codes), plus the tenant-scoped API endpoints it needs.

**Architecture:** New tenant-scoped API endpoints (outlet PATCH, apply-menu-template, areas/tables, tenant status + complete-onboarding), each following the codebase's `assertOutlet` + scoped-read pattern. A Next.js `/onboarding` route in the staff app gates on `tenant.onboardedAt` and walks the owner through five steps, reusing existing API clients (brands/theme) and the `qrcode` dependency.

**Tech Stack:** NestJS 11, Prisma 6, TypeScript 5.8, Zod, vitest (harness from Phase 1), Next.js 15 + React 19, `qrcode`.

**Depends on:** Phase 1 (`feat/tenant-provisioning`) — provisioning engine, `Tenant.onboardedAt`, the vitest harness. This branch (`feat/onboarding-wizard`) is stacked on it.

## Global Constraints

- TypeScript 5.8; NestJS 11; Prisma 6.8; pnpm workspaces (`--filter` from repo root). Next.js 15 / React 19 for the dashboard.
- **No migration** — `Outlet` already has `name/address/gstin/placeOfSupply/upiVpa`; `Tenant.onboardedAt/status/createdVia` exist from Phase 1. Do NOT add a migration.
- **Tenant scoping is sacred.** Every new write endpoint that takes an `:outletId` MUST verify the outlet belongs to the caller's tenant via a scoped read before mutating (the `assertOutlet(user, outletId)` check + a `findFirst({ id, tenantId })` where an id-keyed update follows) — the Prisma tenant-guard passes update-by-id through unscoped, so a path check alone is insufficient (this is the exact Phase-1 stock-toggle IDOR).
- **publicToken scheme** (reuse, do not invent): `randomBytes(9).toString("base64url")` from `node:crypto`. Seed defines it inline (`apps/api/prisma/seed.ts:6`); this plan extracts a shared helper.
- **Table QR URL** (reuse existing scheme from `apps/dashboard/components/ScanOrderTab.tsx:8-11,47`): `${ORDER_BASE}/t/${publicToken}` where `ORDER_BASE = \`${window.location.protocol}//${window.location.hostname}:5176\``. Rendered via `QRCode.toDataURL(url)`.
- Backend tasks are TDD (vitest harness needs local Docker Postgres — `docker compose up -d postgres`, container `stello-postgres` on 5455). The dashboard has NO test harness; frontend tasks gate on `pnpm --filter @stello/dashboard exec tsc --noEmit` + `pnpm --filter @stello/dashboard build`, with runtime flow verified separately (run skill). Do NOT add a frontend test framework.
- Money/prices are Prisma `Decimal`; pass numbers/strings Prisma accepts (e.g. `price: 120`).
- Permission strings already in use: `settings.manage`, `menu.manage`. Owner role = `["*"]`.

---

### Task 1: Shared schemas + tenant DTO

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/types.ts`
- Test: `packages/shared/src/schemas.onboarding.test.ts`

**Interfaces:**
- Produces: `UpdateOutletSchema`/`UpdateOutletInput` (`{name?,address?,gstin?,placeOfSupply?,upiVpa?}`), `CreateAreaSchema`/`CreateAreaInput` (`{name}`), `CreateTablesSchema`/`CreateTablesInput` (`{areaId, count}`), and `TenantSummaryDto` type — consumed by Tasks 2/4/5/7.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/schemas.onboarding.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { UpdateOutletSchema, CreateAreaSchema, CreateTablesSchema } from "./schemas";

describe("onboarding schemas", () => {
  it("UpdateOutletSchema accepts partial + empty", () => {
    expect(UpdateOutletSchema.safeParse({}).success).toBe(true);
    expect(UpdateOutletSchema.safeParse({ name: "Main", gstin: "29ABCDE1234F1Z5" }).success).toBe(true);
  });
  it("CreateAreaSchema requires a name", () => {
    expect(CreateAreaSchema.safeParse({ name: "" }).success).toBe(false);
    expect(CreateAreaSchema.safeParse({ name: "Main" }).success).toBe(true);
  });
  it("CreateTablesSchema bounds count 1..50", () => {
    expect(CreateTablesSchema.safeParse({ areaId: "a", count: 0 }).success).toBe(false);
    expect(CreateTablesSchema.safeParse({ areaId: "a", count: 51 }).success).toBe(false);
    expect(CreateTablesSchema.safeParse({ areaId: "a", count: 8 }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @stello/shared test onboarding`
Expected: FAIL (schemas not exported).

- [ ] **Step 3: Add schemas + DTO**

Append to `packages/shared/src/schemas.ts`:
```ts
export const UpdateOutletSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  address: z.string().max(400).optional(),
  gstin: z.string().max(20).optional(),
  placeOfSupply: z.string().max(4).optional(),
  upiVpa: z.string().max(120).optional(),
});
export type UpdateOutletInput = z.infer<typeof UpdateOutletSchema>;

export const CreateAreaSchema = z.object({ name: z.string().min(1).max(80) });
export type CreateAreaInput = z.infer<typeof CreateAreaSchema>;

export const CreateTablesSchema = z.object({
  areaId: z.string().min(1),
  count: z.number().int().min(1).max(50),
});
export type CreateTablesInput = z.infer<typeof CreateTablesSchema>;
```
Append to `packages/shared/src/types.ts`:
```ts
export interface TenantSummaryDto {
  id: string;
  name: string;
  status: string;
  createdVia: string;
  onboardedAt: string | null;
}
```

- [ ] **Step 4: Run test + build**

Run: `pnpm --filter @stello/shared test onboarding && pnpm --filter @stello/shared build`
Expected: tests PASS; build emits dist.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/schemas.ts packages/shared/src/types.ts packages/shared/src/schemas.onboarding.test.ts
git commit -m "feat(shared): onboarding schemas (outlet update, areas, tables) + TenantSummaryDto"
```

---

### Task 2: `PATCH /outlets/:outletId`

**Files:**
- Modify: `apps/api/src/outlets/outlets.controller.ts`
- Test: `apps/api/test/outlets-update.test.ts`

**Interfaces:**
- Consumes: `UpdateOutletSchema` (Task 1), `PrismaService`, `ZodValidationPipe`, `RequirePermission`.
- Produces: `PATCH /outlets/:outletId` → `{ id }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/outlets-update.test.ts`:
```ts
import { expect, it } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { PrismaService } from "../src/prisma/prisma.service";
import { OutletsController } from "../src/outlets/outlets.controller";
import { testPrisma } from "./db";

async function seedOutlet() {
  const t = await testPrisma.tenant.create({ data: { name: "T" } });
  const b = await testPrisma.brand.create({ data: { tenantId: t.id, name: "B" } });
  const o = await testPrisma.outlet.create({ data: { tenantId: t.id, brandId: b.id, name: "O" } });
  return { t, o };
}
function userFor(tenantId: string, outletIds: string[]) {
  return { id: "u", tenantId, email: "e", name: "n", roleName: "Owner", permissions: ["*"], outletIds, isPlatformAdmin: false };
}

it("updates own outlet fields", async () => {
  const { t, o } = await seedOutlet();
  const ctrl = new OutletsController(new PrismaService());
  await ctrl.update(userFor(t.id, [o.id]) as any, o.id, { address: "12 MG Rd", gstin: "29ABCDE1234F1Z5" });
  const fresh = await testPrisma.outlet.findUnique({ where: { id: o.id } });
  expect(fresh?.address).toBe("12 MG Rd");
  expect(fresh?.gstin).toBe("29ABCDE1234F1Z5");
});

it("rejects updating an outlet in another tenant (no cross-tenant write)", async () => {
  const a = await seedOutlet();
  const b = await seedOutlet();
  const ctrl = new OutletsController(new PrismaService());
  // user from tenant A claims access to A's outlet id list, but targets B's outlet id
  await expect(
    ctrl.update(userFor(a.t.id, [b.o.id]) as any, b.o.id, { name: "hacked" }),
  ).rejects.toThrow(NotFoundException);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @stello/api test outlets-update`
Expected: FAIL (`ctrl.update` is not a function).

- [ ] **Step 3: Implement the PATCH route**

In `apps/api/src/outlets/outlets.controller.ts`, update imports and add the method. Change the import line to:
```ts
import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch } from "@nestjs/common";
import type { AreaDto, AuthUser, OutletDto, UpdateOutletInput } from "@stello/shared";
import { UpdateOutletSchema } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentUser, RequirePermission } from "../common/decorators";
import { ZodValidationPipe } from "../common/zod.pipe";
```
Add this method inside the class:
```ts
  @RequirePermission("settings.manage")
  @Patch(":outletId")
  async update(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(UpdateOutletSchema)) body: UpdateOutletInput,
  ) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
    // Scoped ownership read before the id-keyed update (the tenant-guard passes
    // update-by-id through unscoped, so a path check alone is not enough).
    const owned = await this.prisma.outlet.findFirst({
      where: { id: outletId, tenantId: user.tenantId },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException("Outlet not found");
    const updated = await this.prisma.outlet.update({ where: { id: outletId }, data: body });
    return { id: updated.id };
  }
```

- [ ] **Step 4: Run test**

Run: `pnpm --filter @stello/api test outlets-update`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/outlets/outlets.controller.ts apps/api/test/outlets-update.test.ts
git commit -m "feat(outlets): tenant-scoped PATCH /outlets/:id for onboarding"
```

---

### Task 3: Starter menu template + `POST menu/apply-template`

**Files:**
- Create: `apps/api/src/menu/starter-template.ts`
- Modify: `apps/api/src/menu/menu-admin.controller.ts`
- Modify: `apps/api/src/menu/menu-admin.service.ts`
- Test: `apps/api/test/apply-template.test.ts`

**Interfaces:**
- Consumes: `PrismaService`, existing `assertOutlet` in `MenuAdminService`.
- Produces: `POST /outlets/:outletId/menu/apply-template` → `{ categoriesCreated, itemsCreated }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/apply-template.test.ts`:
```ts
import { expect, it } from "vitest";
import { PrismaService } from "../src/prisma/prisma.service";
import { MenuAdminService } from "../src/menu/menu-admin.service";
import { RealtimeGateway } from "../src/realtime/realtime.gateway";
import { JwtService } from "@nestjs/jwt";
import { testPrisma } from "./db";

it("applies the starter template into the outlet's menu", async () => {
  const t = await testPrisma.tenant.create({ data: { name: "T" } });
  const b = await testPrisma.brand.create({ data: { tenantId: t.id, name: "B" } });
  const o = await testPrisma.outlet.create({ data: { tenantId: t.id, brandId: b.id, name: "O" } });
  const prisma = new PrismaService();
  // MenuAdminService ctor is (prisma, realtime, combos). applyStarterTemplate
  // uses only prisma + realtime, so combos can be null here.
  const svc = new MenuAdminService(prisma, new RealtimeGateway(new JwtService({ secret: "t" }), prisma), null as never);
  const user = { id: "u", tenantId: t.id, email: "e", name: "n", roleName: "Owner", permissions: ["*"], outletIds: [o.id], isPlatformAdmin: false } as any;

  const res = await svc.applyStarterTemplate(user, o.id);
  expect(res.categoriesCreated).toBeGreaterThanOrEqual(3);
  expect(res.itemsCreated).toBeGreaterThanOrEqual(8);

  const cats = await testPrisma.menuCategory.findMany({ where: { outletId: o.id }, include: { items: true } });
  expect(cats.length).toBe(res.categoriesCreated);
  const items = cats.flatMap((c) => c.items);
  expect(items.length).toBe(res.itemsCreated);
  expect(items.every((i) => i.tenantId === t.id && i.outletId === o.id)).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @stello/api test apply-template`
Expected: FAIL (`applyStarterTemplate` missing).

- [ ] **Step 3: Add the template constant + service method + route**

Create `apps/api/src/menu/starter-template.ts`:
```ts
// A small, cuisine-neutral starter menu so a new outlet isn't empty. Prices in INR.
export const STARTER_TEMPLATE: { category: string; items: { name: string; price: number; isVeg: boolean }[] }[] = [
  { category: "Starters", items: [
    { name: "Veg Spring Rolls", price: 160, isVeg: true },
    { name: "Paneer Tikka", price: 220, isVeg: true },
    { name: "Chicken 65", price: 240, isVeg: false },
  ]},
  { category: "Main Course", items: [
    { name: "Paneer Butter Masala", price: 260, isVeg: true },
    { name: "Dal Tadka", price: 180, isVeg: true },
    { name: "Butter Chicken", price: 300, isVeg: false },
  ]},
  { category: "Breads & Rice", items: [
    { name: "Butter Naan", price: 45, isVeg: true },
    { name: "Jeera Rice", price: 140, isVeg: true },
  ]},
  { category: "Beverages", items: [
    { name: "Masala Chai", price: 40, isVeg: true },
    { name: "Fresh Lime Soda", price: 70, isVeg: true },
  ]},
];
```
In `apps/api/src/menu/menu-admin.service.ts`, add the import at top and a method. Import:
```ts
import { STARTER_TEMPLATE } from "./starter-template";
```
Add the method (uses the existing `assertOutlet` and `this.prisma`):
```ts
  async applyStarterTemplate(user: AuthUser, outletId: string): Promise<{ categoriesCreated: number; itemsCreated: number }> {
    this.assertOutlet(user, outletId);
    let categoriesCreated = 0;
    let itemsCreated = 0;
    await this.prisma.$transaction(async (tx) => {
      let sort = 0;
      for (const block of STARTER_TEMPLATE) {
        const cat = await tx.menuCategory.create({
          data: { tenantId: user.tenantId, outletId, name: block.category, sortOrder: sort++ },
        });
        categoriesCreated++;
        for (const item of block.items) {
          await tx.item.create({
            data: {
              tenantId: user.tenantId, outletId, categoryId: cat.id,
              name: item.name, price: item.price, isVeg: item.isVeg,
            },
          });
          itemsCreated++;
        }
      }
    });
    this.realtime.notifyOutlet(outletId);
    return { categoriesCreated, itemsCreated };
  }
```
In `apps/api/src/menu/menu-admin.controller.ts`, add the route (class already has `@RequirePermission("menu.manage")` semantics — match the existing pattern in that file; if permission is per-route there, add `@RequirePermission("menu.manage")`):
```ts
  @Post("menu/apply-template")
  applyTemplate(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string) {
    return this.svc.applyStarterTemplate(user, outletId);
  }
```
(Confirm the controller's existing imports include `Post`, `CurrentUser`, `Param`, `AuthUser`; they do — other routes use them.)

- [ ] **Step 4: Run test**

Run: `pnpm --filter @stello/api test apply-template`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/menu/starter-template.ts apps/api/src/menu/menu-admin.service.ts apps/api/src/menu/menu-admin.controller.ts apps/api/test/apply-template.test.ts
git commit -m "feat(menu): starter-menu template + POST apply-template for onboarding"
```

---

### Task 4: public-token helper + areas/tables endpoints

**Files:**
- Create: `apps/api/src/common/public-token.ts`
- Create: `apps/api/src/onboarding/onboarding.controller.ts`
- Create: `apps/api/src/onboarding/onboarding.module.ts`
- Modify: `apps/api/src/app.module.ts` (register module)
- Test: `apps/api/test/areas-tables.test.ts`

**Interfaces:**
- Consumes: `CreateAreaSchema`, `CreateTablesSchema` (Task 1), `PrismaService`.
- Produces: `POST /outlets/:outletId/areas` → `{ id, name }`; `POST /outlets/:outletId/tables` → `{ tables: {id,name,publicToken}[] }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/areas-tables.test.ts`:
```ts
import { expect, it } from "vitest";
import { PrismaService } from "../src/prisma/prisma.service";
import { OnboardingController } from "../src/onboarding/onboarding.controller";
import { testPrisma } from "./db";

async function seed() {
  const t = await testPrisma.tenant.create({ data: { name: "T" } });
  const b = await testPrisma.brand.create({ data: { tenantId: t.id, name: "B" } });
  const o = await testPrisma.outlet.create({ data: { tenantId: t.id, brandId: b.id, name: "O" } });
  return { t, o };
}
const userFor = (tenantId: string, outletIds: string[]) =>
  ({ id: "u", tenantId, email: "e", name: "n", roleName: "Owner", permissions: ["*"], outletIds, isPlatformAdmin: false }) as any;

it("creates an area then tables with unique publicTokens", async () => {
  const { t, o } = await seed();
  const ctrl = new OnboardingController(new PrismaService());
  const area = await ctrl.createArea(userFor(t.id, [o.id]), o.id, { name: "Main" });
  const res = await ctrl.createTables(userFor(t.id, [o.id]), o.id, { areaId: area.id, count: 4 });
  expect(res.tables).toHaveLength(4);
  const tokens = new Set(res.tables.map((x) => x.publicToken));
  expect(tokens.size).toBe(4);
  const rows = await testPrisma.diningTable.findMany({ where: { outletId: o.id } });
  expect(rows.length).toBe(4);
  expect(rows.every((r) => r.tenantId === t.id && r.areaId === area.id)).toBe(true);
});

it("rejects creating tables under an area from another tenant", async () => {
  const a = await seed();
  const b = await seed();
  const areaB = await testPrisma.area.create({ data: { tenantId: b.t.id, outletId: b.o.id, name: "X" } });
  const ctrl = new OnboardingController(new PrismaService());
  await expect(
    ctrl.createTables(userFor(a.t.id, [a.o.id]), a.o.id, { areaId: areaB.id, count: 2 }),
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @stello/api test areas-tables`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement helper + controller + module**

Create `apps/api/src/common/public-token.ts`:
```ts
import { randomBytes } from "node:crypto";
/** Opaque token for Scan & Order QR URLs. Matches the scheme used in the seed. */
export const publicToken = (): string => randomBytes(9).toString("base64url");
```
Create `apps/api/src/onboarding/onboarding.controller.ts`:
```ts
import { Body, Controller, ForbiddenException, NotFoundException, Param, Post } from "@nestjs/common";
import { CreateAreaSchema, CreateTablesSchema, type AuthUser, type CreateAreaInput, type CreateTablesInput } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentUser, RequirePermission } from "../common/decorators";
import { ZodValidationPipe } from "../common/zod.pipe";
import { publicToken } from "../common/public-token";

@Controller("outlets/:outletId")
export class OnboardingController {
  constructor(private readonly prisma: PrismaService) {}

  private assertOutlet(user: AuthUser, outletId: string) {
    if (!user.outletIds.includes(outletId)) throw new ForbiddenException("No access to outlet");
  }

  @RequirePermission("settings.manage")
  @Post("areas")
  async createArea(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(CreateAreaSchema)) body: CreateAreaInput,
  ) {
    this.assertOutlet(user, outletId);
    const owned = await this.prisma.outlet.findFirst({ where: { id: outletId, tenantId: user.tenantId }, select: { id: true } });
    if (!owned) throw new NotFoundException("Outlet not found");
    const area = await this.prisma.area.create({ data: { tenantId: user.tenantId, outletId, name: body.name } });
    return { id: area.id, name: area.name };
  }

  @RequirePermission("settings.manage")
  @Post("tables")
  async createTables(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Body(new ZodValidationPipe(CreateTablesSchema)) body: CreateTablesInput,
  ) {
    this.assertOutlet(user, outletId);
    // The area must belong to the same tenant + outlet.
    const area = await this.prisma.area.findFirst({
      where: { id: body.areaId, tenantId: user.tenantId, outletId },
      select: { id: true },
    });
    if (!area) throw new NotFoundException("Area not found");
    const tables = await this.prisma.$transaction(
      Array.from({ length: body.count }, (_, i) =>
        this.prisma.diningTable.create({
          data: { tenantId: user.tenantId, outletId, areaId: area.id, name: `Table ${i + 1}`, publicToken: publicToken() },
          select: { id: true, name: true, publicToken: true },
        }),
      ),
    );
    return { tables };
  }
}
```
Create `apps/api/src/onboarding/onboarding.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { OnboardingController } from "./onboarding.controller";
@Module({ controllers: [OnboardingController] })
export class OnboardingModule {}
```
In `apps/api/src/app.module.ts` add `import { OnboardingModule } from "./onboarding/onboarding.module";` and list `OnboardingModule,` in `imports`.

- [ ] **Step 4: Run test + build**

Run: `pnpm --filter @stello/api test areas-tables && pnpm --filter @stello/api build`
Expected: PASS + build ok.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/common/public-token.ts apps/api/src/onboarding/ apps/api/src/app.module.ts apps/api/test/areas-tables.test.ts
git commit -m "feat(onboarding): areas + tables creation endpoints with QR publicTokens"
```

---

### Task 5: `GET /tenant` + `POST /tenant/onboarding/complete`

**Files:**
- Create: `apps/api/src/tenant/tenant.controller.ts`
- Create: `apps/api/src/tenant/tenant.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/tenant-status.test.ts`

**Interfaces:**
- Produces: `GET /tenant` → `TenantSummaryDto`; `POST /tenant/onboarding/complete` → `{ onboardedAt }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/tenant-status.test.ts`:
```ts
import { expect, it } from "vitest";
import { PrismaService } from "../src/prisma/prisma.service";
import { TenantController } from "../src/tenant/tenant.controller";
import { testPrisma } from "./db";

const userFor = (tenantId: string) =>
  ({ id: "u", tenantId, email: "e", name: "n", roleName: "Owner", permissions: ["*"], outletIds: [], isPlatformAdmin: false }) as any;

it("returns tenant summary and completes onboarding", async () => {
  const t = await testPrisma.tenant.create({ data: { name: "Spice Route", createdVia: "ADMIN" } });
  const ctrl = new TenantController(new PrismaService());

  const before = await ctrl.current(userFor(t.id));
  expect(before.name).toBe("Spice Route");
  expect(before.onboardedAt).toBeNull();

  const done = await ctrl.complete(userFor(t.id));
  expect(done.onboardedAt).not.toBeNull();

  const after = await ctrl.current(userFor(t.id));
  expect(after.onboardedAt).not.toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @stello/api test tenant-status`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement controller + module**

Create `apps/api/src/tenant/tenant.controller.ts`:
```ts
import { Controller, Get, NotFoundException, Post } from "@nestjs/common";
import type { AuthUser, TenantSummaryDto } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentUser, RequirePermission } from "../common/decorators";

@Controller("tenant")
export class TenantController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async current(@CurrentUser() user: AuthUser): Promise<TenantSummaryDto> {
    const t = await this.prisma.tenant.findUnique({ where: { id: user.tenantId } });
    if (!t) throw new NotFoundException("Tenant not found");
    return {
      id: t.id, name: t.name, status: t.status, createdVia: t.createdVia,
      onboardedAt: t.onboardedAt ? t.onboardedAt.toISOString() : null,
    };
  }

  @RequirePermission("settings.manage")
  @Post("onboarding/complete")
  async complete(@CurrentUser() user: AuthUser): Promise<{ onboardedAt: string }> {
    const t = await this.prisma.tenant.update({
      where: { id: user.tenantId },
      data: { onboardedAt: new Date() },
    });
    return { onboardedAt: t.onboardedAt!.toISOString() };
  }
}
```
Create `apps/api/src/tenant/tenant.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { TenantController } from "./tenant.controller";
@Module({ controllers: [TenantController] })
export class TenantModule {}
```
Register `TenantModule` in `apps/api/src/app.module.ts` (import + `imports` array).

> Note on scoping: `Tenant` has no `tenantId` column, so it is not in the Prisma tenant-guard's `TENANT_MODELS` — reads/writes here are keyed by `user.tenantId` from the verified JWT, so a caller can only ever read/complete their OWN tenant. No cross-tenant exposure.

- [ ] **Step 4: Run test + build**

Run: `pnpm --filter @stello/api test tenant-status && pnpm --filter @stello/api build`
Expected: PASS + build ok.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/tenant/ apps/api/src/app.module.ts apps/api/test/tenant-status.test.ts
git commit -m "feat(tenant): GET /tenant + POST /tenant/onboarding/complete"
```

---

### Task 6: e2e — onboarding endpoints enforce auth + tenant scoping

**Files:**
- Test: `apps/api/test/onboarding.e2e.test.ts`

**Interfaces:**
- Consumes: the whole booted `AppModule` (SWC transform from Phase 1's fast-follow enables Nest DI tests).

- [ ] **Step 1: Write the e2e**

Create `apps/api/test/onboarding.e2e.test.ts`. Boot the app (same pattern as `platform.e2e.test.ts`), seed two tenants each with an owner (known password), log both in, and assert:
```ts
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
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @stello/api test onboarding.e2e`
Expected: PASS. (If cross-tenant returns 200, that is a CRITICAL isolation bug — stop and report.)

- [ ] **Step 3: Full suite + commit**

Run: `pnpm --filter @stello/api test`
Expected: all PASS.
```bash
git add apps/api/test/onboarding.e2e.test.ts
git commit -m "test(onboarding): e2e — outlet PATCH is owner-only and tenant-scoped"
```

---

### Task 7: Frontend API client + tenant-status gating

**Files:**
- Modify: `apps/dashboard/lib/api.ts`
- Modify: `apps/dashboard/components/SessionProvider.tsx` (or wherever session state lives — confirm by reading it)
- Modify: the root role-router (`apps/dashboard/app/page.tsx`) and/or `Shell` — confirm current gating flow before editing

**Interfaces:**
- Produces: `api.getTenant()`, `api.updateOutlet()`, `api.applyMenuTemplate()`, `api.createArea()`, `api.createTables()`, `api.completeOnboarding()`; and session exposure of `tenant` so routing can gate on `onboardedAt`.

- [ ] **Step 1: Read the current session + routing flow**

Run: read `apps/dashboard/components/SessionProvider.tsx`, `apps/dashboard/app/page.tsx`, `apps/dashboard/components/Shell.tsx`, and `apps/dashboard/lib/api.ts`. Identify: how `user` is fetched/stored after login, and where the post-login redirect-by-role happens. The gating must slot into THAT flow (do not add a parallel router).

- [ ] **Step 2: Add API client methods**

In `apps/dashboard/lib/api.ts`, add methods following the file's existing `request()` helper and `BASE = "/api/v1"` convention:
```ts
  getTenant: () => request<{ id: string; name: string; status: string; createdVia: string; onboardedAt: string | null }>("/tenant"),
  updateOutlet: (outletId: string, body: Record<string, unknown>) =>
    request<{ id: string }>(`/outlets/${outletId}`, { method: "PATCH", body: JSON.stringify(body) }),
  applyMenuTemplate: (outletId: string) =>
    request<{ categoriesCreated: number; itemsCreated: number }>(`/outlets/${outletId}/menu/apply-template`, { method: "POST" }),
  createArea: (outletId: string, name: string) =>
    request<{ id: string; name: string }>(`/outlets/${outletId}/areas`, { method: "POST", body: JSON.stringify({ name }) }),
  createTables: (outletId: string, areaId: string, count: number) =>
    request<{ tables: { id: string; name: string; publicToken: string }[] }>(`/outlets/${outletId}/tables`, { method: "POST", body: JSON.stringify({ areaId, count }) }),
  completeOnboarding: () => request<{ onboardedAt: string }>("/tenant/onboarding/complete", { method: "POST" }),
```
(Match the exact shape/casing of the existing methods in that file — the above is the intended surface; adapt to the file's actual `request` signature.)

- [ ] **Step 3: Gate on onboarding status**

In the session/routing flow found in Step 1: after `user` is established, fetch `api.getTenant()` and store it in session context. In the root router: if `user` has `settings.manage` (owner) AND `tenant.onboardedAt == null` AND current path isn't already `/onboarding`, `router.replace("/onboarding")`. Non-owners are unaffected. Keep this in the SAME place the existing role-redirect lives.

- [ ] **Step 4: Typecheck + build**

Run: `pnpm --filter @stello/dashboard exec tsc --noEmit && pnpm --filter @stello/dashboard build`
Expected: no type errors; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/lib/api.ts apps/dashboard/components/SessionProvider.tsx apps/dashboard/app/page.tsx
git commit -m "feat(dashboard): onboarding API client + gate owners on tenant.onboardedAt"
```

---

### Task 8: Frontend onboarding wizard UI

**Files:**
- Create: `apps/dashboard/app/onboarding/page.tsx`
- Create: `apps/dashboard/components/onboarding/OnboardingWizard.tsx`
- Create: `apps/dashboard/app/onboarding/onboarding.css` (or reuse the Console CSS-module pattern present in the repo — confirm the styling convention)

**Interfaces:**
- Consumes: the API client methods (Task 7), `qrcode` (already a dependency), the session's `user`/`tenant`.

- [ ] **Step 1: Build the wizard component**

Create `OnboardingWizard.tsx` — a client component with local step state (`0..4`) and per-step form state. Steps:
1. **Brand & theme**: text input (restaurant name) + theme picker (reuse the same theme options the Console `AppearanceTab` uses — read it for the list) → on Next, call the existing brand-update API used by AppearanceTab. Required (name non-empty).
2. **Outlet & GST**: inputs name/address/gstin/placeOfSupply/upiVpa → `api.updateOutlet(outletId, {...})`. Required: name+address non-empty; GST fields optional.
3. **Starter menu**: two radio choices ("Add a sample menu" / "Start blank"). On Next: if sample, `api.applyMenuTemplate(outletId)`. Skippable (default blank).
4. **Tables & QR**: number input (count, 1–50). On Next: ensure a "Main" area exists — call `api.createArea(outletId, "Main")` (first run) → `api.createTables(outletId, areaId, count)`; then render each returned table's QR with `QRCode.toDataURL(`${ORDER_BASE}/t/${table.publicToken}`)` where `ORDER_BASE` follows the exact `ScanOrderTab.tsx` scheme. Provide a print affordance. Skippable.
5. **Finish**: summary + a "Finish setup" button → `api.completeOnboarding()` → `router.replace("/console")` (or the app's Console route).

The `outletId` is `user.outletIds[0]`. Include Back/Next/Skip controls, a step progress indicator, and per-step loading + error banners following the existing Console error-banner pattern (read one Console tab, e.g. `InventoryTab`, to match the pattern — do NOT invent a new toast system). No `any`; type against the API client return types.

Create `app/onboarding/page.tsx` that renders `<OnboardingWizard/>` inside the app's authenticated shell context (match how other authed pages mount — read `app/console/page.tsx`).

- [ ] **Step 2: Typecheck + build**

Run: `pnpm --filter @stello/dashboard exec tsc --noEmit && pnpm --filter @stello/dashboard build`
Expected: no type errors; build succeeds (Next prerenders the route).

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/app/onboarding/ apps/dashboard/components/onboarding/
git commit -m "feat(dashboard): onboarding wizard UI (brand, outlet, menu, tables/QR, finish)"
```

---

## Manual/run verification (after all tasks)

With the stack running (`docker compose up -d`, `pnpm dev:api`, dashboard dev server), or on the real stack:
1. Provision a fresh tenant via Phase 1 (`POST /platform/tenants` as a platform admin) and note the owner login.
2. Log in as that owner → you should be redirected to `/onboarding`.
3. Walk all five steps: set brand+theme, fill outlet+GST, choose the sample menu, create 4 tables, finish.
4. Confirm in Console: the outlet shows the address/GST, the menu has the starter items, four tables exist with scannable QR codes, and re-logging-in as the owner goes straight to Console (wizard does not reappear).
5. Log in as a cashier of an un-onboarded tenant → confirm they are NOT sent to the wizard.

## Self-review notes (coverage vs spec)

- Spec §Backend 1 (outlet PATCH, scoped) → Task 2 (+ e2e Task 6). ✓
- Spec §Backend 2 (apply-template) → Task 3. ✓
- Spec §Backend 3 (areas/tables + publicToken) → Task 4. ✓
- Spec §Backend 4 (GET /tenant + complete) → Task 5. ✓
- Spec §Frontend (gating + wizard, reuse brand/theme + qrcode + QR scheme) → Tasks 7–8. ✓
- Spec §Testing (harness unit tests + cross-tenant e2e; frontend build-gated + run-verified) → Tasks 2–6 tests, Task 6 e2e, Tasks 7–8 build gates, manual verification section. ✓
- No migration (per Global Constraints; Outlet fields + onboardedAt already exist). ✓
- Deferred/out-of-scope (invites, email, logo, billing) → not present in any task. ✓
