# Themeable Design System — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a per-brand, token-driven theme system with 11 selectable themes, chosen in the Console's Settings → Appearance and applied to the POS (the pilot), with the backend and shared foundations that Phase 2 apps will reuse.

**Architecture:** One theme registry in `@stello/shared` defines 11 themes as sets of ~25 CSS-variable tokens. A framework-agnostic `applyTheme()` writes those variables onto `<html>`; each app wraps it. `Brand.themeId` persists the choice; the API exposes it on the Outlet DTO and sync snapshot and accepts updates via a guarded `PATCH /brands/:id/theme`. The POS consumes the tokens (via CSS variables + a Tailwind preset) so it re-themes instantly.

**Tech Stack:** TypeScript, Zod, NestJS + Prisma (PostgreSQL), React + Vite (POS), Next.js (Console), Tailwind CSS, lucide-react, framer-motion, vitest (new, in `@stello/shared`).

## Global Constraints

- Package scope is `@stello/*`. Shared types/schemas live in `@stello/shared` and are re-exported from `packages/shared/src/index.ts`.
- Permissions are enforced by `apps/api/src/auth/jwt-auth.guard.ts`, which allows a request when `required.every(p => user.permissions.includes(p) || user.permissions.includes("*"))`. Owner role holds `["*"]`.
- Theme ids (stable slugs, do not rename): `mise, line, counter, thali, slate, aurora, ember, console, noir, herb, tiffin`. `DEFAULT_THEME_ID = "counter"`.
- Permission for changing the theme: `settings.manage` (Owner-only via `*`).
- No new test runner outside `@stello/shared`. In shared, use **vitest**. API and UI tasks verify via build/typecheck and executable checks (curl / dev server), matching the repo's existing no-test pattern.
- `@stello/shared` must stay DOM-free (its tsconfig has no `DOM` lib) — `applyTheme` takes a structural target, not `HTMLElement`.
- Fonts are system stacks only (CSP blocks webfonts). SANS/SERIF/MONO constants defined in Task 1.
- After editing `@stello/shared`, rebuild it (`pnpm --filter @stello/shared build`) before dependents typecheck.
- Money/format conventions and existing code style are unchanged.

---

### Task 1: Theme registry, token contract & schema (`@stello/shared`)

**Files:**
- Create: `packages/shared/src/theme.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from "./theme";`)
- Modify: `packages/shared/src/schemas.ts` (append `UpdateBrandThemeSchema`)
- Create: `packages/shared/src/theme.test.ts`
- Modify: `packages/shared/package.json` (add vitest + `test` script)
- Create: `packages/shared/vitest.config.ts`

**Interfaces:**
- Produces: `Theme` (`{ id, letter, name, description, mode: "light"|"dark", tokens: Record<string,string> }`), `THEMES: Theme[]`, `DEFAULT_THEME_ID = "counter"`, `getTheme(id: string): Theme`, `isThemeId(id: string): boolean`, `REQUIRED_TOKENS: string[]`, `applyTheme(theme: Theme, root: StyleTarget): void`, and Zod `UpdateBrandThemeSchema` / `UpdateBrandThemeInput`.

- [ ] **Step 1: Add vitest to the shared package**

Modify `packages/shared/package.json` — add to `scripts` and `devDependencies`:

```json
"scripts": {
  "build": "tsc -p tsconfig.json",
  "test": "vitest run"
},
"devDependencies": {
  "typescript": "^5.8.0",
  "vitest": "^2.1.0"
}
```

Create `packages/shared/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node" } });
```

Run: `pnpm install`
Expected: vitest added, no errors.

- [ ] **Step 2: Write the failing test**

Create `packages/shared/src/theme.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  THEMES, DEFAULT_THEME_ID, getTheme, isThemeId, REQUIRED_TOKENS, applyTheme, type Theme,
} from "./theme";

describe("theme registry", () => {
  it("has the 11 expected theme ids", () => {
    expect(THEMES.map((t) => t.id).sort()).toEqual(
      ["aurora","console","counter","ember","herb","line","mise","noir","slate","thali","tiffin"]
    );
  });

  it("every theme defines every required token", () => {
    for (const t of THEMES) {
      for (const key of REQUIRED_TOKENS) {
        expect(t.tokens[key], `${t.id} missing ${key}`).toBeTruthy();
      }
    }
  });

  it("default theme exists", () => {
    expect(isThemeId(DEFAULT_THEME_ID)).toBe(true);
    expect(getTheme(DEFAULT_THEME_ID).id).toBe(DEFAULT_THEME_ID);
  });

  it("getTheme falls back to default on unknown id", () => {
    expect(getTheme("nope").id).toBe(DEFAULT_THEME_ID);
    expect(isThemeId("nope")).toBe(false);
  });

  it("body text is legible on the background (WCAG AA >= 4.5)", () => {
    const hex = (s: string) => /^#[0-9a-f]{6}$/i.test(s);
    const lum = (h: string) => {
      const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a: string, b: string) => {
      const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (l1 + 0.05) / (l2 + 0.05);
    };
    // Body-text legibility: ink on the page background. (Accent-button label
    // contrast is large-text and tuned per app in Phase 2.) Skip non-hex
    // tokens such as Aurora's gradient background.
    for (const t of THEMES) {
      const ink = t.tokens["--ink"], bg = t.tokens["--bg"];
      if (hex(ink) && hex(bg)) {
        expect(ratio(ink, bg), `${t.id} body contrast`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("applyTheme writes every token and stamps data attributes", () => {
    const set: Record<string, string> = {};
    const attrs: Record<string, string> = {};
    const target = {
      style: { setProperty: (p: string, v: string) => { set[p] = v; } },
      setAttribute: (n: string, v: string) => { attrs[n] = v; },
    };
    const theme = getTheme("line");
    applyTheme(theme as Theme, target);
    expect(set["--accent"]).toBe(theme.tokens["--accent"]);
    expect(attrs["data-theme"]).toBe("line");
    expect(attrs["data-mode"]).toBe("dark");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @stello/shared test`
Expected: FAIL — `Cannot find module "./theme"`.

- [ ] **Step 4: Create the registry implementation**

Create `packages/shared/src/theme.ts`:

```ts
export type ThemeMode = "light" | "dark";

export interface Theme {
  id: string;
  letter: string;
  name: string;
  description: string;
  mode: ThemeMode;
  tokens: Record<string, string>;
}

/** Structural target so this file stays DOM-free (shared tsconfig has no DOM lib). */
export type StyleTarget = {
  style: { setProperty(prop: string, value: string): void };
  setAttribute(name: string, value: string): void;
};

const SANS = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
const MONO = 'ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';

export const REQUIRED_TOKENS = [
  "--bg","--panel","--panel-2","--card-bg","--ink","--muted","--faint","--line",
  "--accent","--accent-ink","--accent-soft","--veg","--nonveg","--good","--warn","--crit",
  "--radius","--radius-sm","--gap","--shadow","--font-display","--font-body","--font-num",
  "--label-tt","--label-ls",
];

type Tok = Record<string, string>;
const lightBase: Tok = { "--good": "#2f7d47", "--warn": "#c07a09", "--crit": "#b23a32",
  "--font-body": SANS, "--gap": "12px", "--label-tt": "none", "--label-ls": "0" };
const darkBase: Tok = { "--good": "#5fbb76", "--warn": "#e0a83c", "--crit": "#e07069",
  "--font-body": SANS, "--gap": "10px", "--label-tt": "none", "--label-ls": "0" };

function make(id: string, letter: string, name: string, description: string,
  mode: ThemeMode, overrides: Tok): Theme {
  return { id, letter, name, description, mode,
    tokens: { ...(mode === "dark" ? darkBase : lightBase), ...overrides } };
}

export const THEMES: Theme[] = [
  make("mise","A","Mise en Place","Warm premium hospitality","light",{
    "--bg":"#fbf7ef","--panel":"#fdfbf5","--panel-2":"#f2ebdd","--card-bg":"#fffdf7","--ink":"#2a2018",
    "--muted":"#7c6f5c","--faint":"#a99e88","--line":"#e6dcc8","--accent":"#c2691a","--accent-ink":"#fdfbf5",
    "--accent-soft":"#f3e2cd","--veg":"#3f7d4f","--nonveg":"#ba4a1e","--radius":"16px","--radius-sm":"11px",
    "--shadow":"0 10px 30px rgba(120,90,40,.10)","--font-display":SERIF,"--font-num":SERIF }),
  make("line","B","Line","Sleek dark operator console","dark",{
    "--bg":"#0d1117","--panel":"#11161d","--panel-2":"#161c24","--card-bg":"#131922","--ink":"#e6edf3",
    "--muted":"#8b98a8","--faint":"#5b6675","--line":"#222b36","--accent":"#2dd4bf","--accent-ink":"#04120f",
    "--accent-soft":"#0f2a26","--veg":"#3fb950","--nonveg":"#f0883e","--radius":"10px","--radius-sm":"7px",
    "--shadow":"0 12px 34px rgba(0,0,0,.5)","--font-display":SANS,"--font-num":MONO,
    "--label-tt":"uppercase","--label-ls":".08em" }),
  make("counter","C","Counter","Bright modern SaaS","light",{
    "--bg":"#f8fafc","--panel":"#ffffff","--panel-2":"#f1f5f9","--card-bg":"#ffffff","--ink":"#0f172a",
    "--muted":"#64748b","--faint":"#94a3b8","--line":"#e2e8f0","--accent":"#6366f1","--accent-ink":"#ffffff",
    "--accent-soft":"#e6e7fd","--veg":"#16a34a","--nonveg":"#dc2626","--radius":"14px","--radius-sm":"9px",
    "--shadow":"0 10px 26px rgba(15,23,42,.06)","--font-display":SANS,"--font-num":SANS }),
  make("thali","D","Thali","Vibrant Indian editorial","light",{
    "--bg":"#fff8ec","--panel":"#fffdf8","--panel-2":"#ffeccd","--card-bg":"#fffdf8","--ink":"#241a3a",
    "--muted":"#7a6a86","--faint":"#b3a4bd","--line":"#f0dcc0","--accent":"#e77817","--accent-ink":"#fff8ec",
    "--accent-soft":"#ffe1bd","--veg":"#2f9e44","--nonveg":"#d1391f","--radius":"15px","--radius-sm":"10px",
    "--shadow":"0 12px 30px rgba(120,60,10,.13)","--font-display":SERIF,"--font-num":SANS }),
  make("slate","E","Slate","Swiss minimalist monochrome","light",{
    "--bg":"#f4f4f1","--panel":"#fbfbf9","--panel-2":"#ebebe7","--card-bg":"#fbfbf9","--ink":"#161615",
    "--muted":"#6a6a66","--faint":"#a6a6a0","--line":"#dbdbd5","--accent":"#18181a","--accent-ink":"#f4f4f1",
    "--accent-soft":"#e6e6e2","--veg":"#2f7d4f","--nonveg":"#c8442f","--radius":"5px","--radius-sm":"4px",
    "--shadow":"0 8px 22px rgba(0,0,0,.05)","--font-display":SANS,"--font-num":SANS,
    "--label-tt":"uppercase","--label-ls":".07em" }),
  make("aurora","F","Aurora","Glassmorphism soft-depth","light",{
    "--bg":"linear-gradient(135deg,#e5ecff 0%,#f4e6ff 45%,#ffe6f2 75%,#e2f6ff 100%)",
    "--panel":"rgba(255,255,255,.55)","--panel-2":"rgba(255,255,255,.42)","--card-bg":"rgba(255,255,255,.5)",
    "--ink":"#1e2140","--muted":"#5a5e86","--faint":"#9498c0","--line":"rgba(255,255,255,.7)",
    "--accent":"#7c3aed","--accent-ink":"#ffffff","--accent-soft":"rgba(124,58,237,.16)","--veg":"#0e9f6e",
    "--nonveg":"#e0417a","--radius":"18px","--radius-sm":"12px","--shadow":"0 20px 50px rgba(80,60,160,.18)",
    "--font-display":SANS,"--font-num":SANS,"--card-blur":"blur(14px) saturate(1.3)" }),
  make("ember","G","Ember","Warm dark terminal","dark",{
    "--bg":"#17120d","--panel":"#1e1811","--panel-2":"#241d14","--card-bg":"#211a12","--ink":"#f2e7d6",
    "--muted":"#a89479","--faint":"#6e6151","--line":"#342a1d","--accent":"#f0a13a","--accent-ink":"#1a1206",
    "--accent-soft":"#3a2a12","--veg":"#88b04b","--nonveg":"#e0783c","--radius":"11px","--radius-sm":"8px",
    "--shadow":"0 14px 36px rgba(0,0,0,.55)","--font-display":SANS,"--font-num":MONO,
    "--label-tt":"uppercase","--label-ls":".07em" }),
  make("console","H","Countertop Console","Neo-brutalist industrial","light",{
    "--bg":"#d8d3c4","--panel":"#e6e2d6","--panel-2":"#cfcabb","--card-bg":"#efece1","--ink":"#1b1c18",
    "--muted":"#54564b","--faint":"#8a8c7e","--line":"#1b1c18","--accent":"#ff5a1f","--accent-ink":"#1b1c18",
    "--accent-soft":"#ffd9c7","--veg":"#2f7d32","--nonveg":"#b3261e","--radius":"2px","--radius-sm":"1px",
    "--shadow":"4px 4px 0 0 #1b1c18","--font-display":SANS,"--font-num":MONO,
    "--label-tt":"uppercase","--label-ls":".08em","--btn-shadow":"3px 3px 0 0 #1b1c18" }),
  make("noir","I","Maison Noir","Fine-dining noir","dark",{
    "--bg":"#0b0a08","--panel":"#131109","--panel-2":"#1a1710","--card-bg":"#141108","--ink":"#efe7d6",
    "--muted":"#a89a7e","--faint":"#6e6552","--line":"#2a2517","--accent":"#c9a34e","--accent-ink":"#120d02",
    "--accent-soft":"#211a0d","--veg":"#8ba05a","--nonveg":"#c06a58","--radius":"10px","--radius-sm":"6px",
    "--shadow":"0 22px 50px -18px rgba(0,0,0,.72)","--font-display":SERIF,"--font-num":MONO,
    "--label-tt":"uppercase","--label-ls":".16em" }),
  make("herb","J","Herb & Honey","Fresh-market botanical","light",{
    "--bg":"#f4f6ee","--panel":"#fbfcf7","--panel-2":"#eef2e4","--card-bg":"#ffffff","--ink":"#22301f",
    "--muted":"#5e6d55","--faint":"#94a189","--line":"#dde3cf","--accent":"#2f7d3f","--accent-ink":"#f4f9ef",
    "--accent-soft":"#e2efd6","--veg":"#5fbf5f","--nonveg":"#c0492f","--radius":"18px","--radius-sm":"11px",
    "--shadow":"0 6px 20px -8px rgba(47,80,40,.28)","--font-display":SERIF,"--font-num":MONO,
    "--label-tt":"uppercase","--label-ls":".08em" }),
  make("tiffin","K","Tiffin Pop","Neo-bento QSR","light",{
    "--bg":"#fbf3ee","--panel":"#ffffff","--panel-2":"#fdece4","--card-bg":"#ffffff","--ink":"#2c2320",
    "--muted":"#7d6f68","--faint":"#b8a89f","--line":"#f0ddd2","--accent":"#ff5a5f","--accent-ink":"#ffffff",
    "--accent-soft":"#ffe4e1","--veg":"#2fb37a","--nonveg":"#e8543a","--radius":"20px","--radius-sm":"12px",
    "--shadow":"0 6px 0 #f2d9cd,0 12px 24px -12px rgba(255,90,95,.35)","--font-display":SANS,"--font-num":MONO,
    "--label-tt":"uppercase","--label-ls":".06em","--btn-shadow":"0 4px 0 #e8443f" }),
];

export const DEFAULT_THEME_ID = "counter";
const BY_ID = new Map(THEMES.map((t) => [t.id, t]));
export function isThemeId(id: string): boolean { return BY_ID.has(id); }
export function getTheme(id: string): Theme { return BY_ID.get(id) ?? BY_ID.get(DEFAULT_THEME_ID)!; }

export function applyTheme(theme: Theme, root: StyleTarget): void {
  for (const [k, v] of Object.entries(theme.tokens)) root.style.setProperty(k, v);
  root.setAttribute("data-theme", theme.id);
  root.setAttribute("data-mode", theme.mode);
}
```

- [ ] **Step 5: Add the Zod schema for updates**

Append to `packages/shared/src/schemas.ts`:

```ts
import { THEMES } from "./theme";
export const UpdateBrandThemeSchema = z.object({
  themeId: z.enum(THEMES.map((t) => t.id) as [string, ...string[]]),
});
export type UpdateBrandThemeInput = z.infer<typeof UpdateBrandThemeSchema>;
```

(If `schemas.ts` already imports `z` at the top, do not re-import it — only add the schema.)

- [ ] **Step 6: Export the module**

Add to `packages/shared/src/index.ts`:

```ts
export * from "./theme";
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @stello/shared test`
Expected: PASS (6 tests).

- [ ] **Step 8: Build shared so dependents see the new exports**

Run: `pnpm --filter @stello/shared build`
Expected: no TypeScript errors.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/theme.ts packages/shared/src/theme.test.ts packages/shared/src/index.ts packages/shared/src/schemas.ts packages/shared/package.json packages/shared/vitest.config.ts pnpm-lock.yaml
git commit -m "feat(shared): theme registry, token contract, applyTheme + tests"
```

---

### Task 2: Persist the theme on the brand (Prisma)

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (Brand model)
- Modify: `apps/api/prisma/seed.ts:16-18` (brand create)

**Interfaces:**
- Produces: `Brand.themeId: string` (default `"counter"`), available to all API services via Prisma.

- [ ] **Step 1: Add the column**

In `apps/api/prisma/schema.prisma`, change the `Brand` model to add `themeId`:

```prisma
model Brand {
  id       String @id @default(cuid())
  tenantId String
  name     String
  themeId  String @default("counter")

  tenant  Tenant   @relation(fields: [tenantId], references: [id])
  outlets Outlet[]

  @@index([tenantId])
  @@map("brands")
}
```

- [ ] **Step 2: Set it explicitly in the seed**

In `apps/api/prisma/seed.ts`, update the brand create:

```ts
const brand = await prisma.brand.create({
  data: { tenantId: tenant.id, name: "Stello Kitchens", themeId: "counter" },
});
```

- [ ] **Step 3: Generate the migration**

Run: `docker compose up -d && pnpm --filter @stello/api prisma:migrate --name add_brand_theme`
Expected: migration `add_brand_theme` created and applied; `prisma generate` runs.

- [ ] **Step 4: Reseed and verify the column**

Run: `pnpm --filter @stello/api prisma:seed`
Then verify: `docker exec stello-postgres psql -U stello -d stello -c "select name, \"themeId\" from brands;"`
Expected: one row, `Stello Kitchens | counter`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/seed.ts apps/api/prisma/migrations
git commit -m "feat(api): add Brand.themeId (default counter) + migration + seed"
```

---

### Task 3: Expose the theme on Outlet DTO and sync snapshot

**Files:**
- Modify: `packages/shared/src/types.ts` (`OutletDto`, `SyncSnapshotDto`)
- Modify: `apps/api/src/outlets/outlets.controller.ts` (map `themeId` + `brandId`)
- Modify: `apps/api/src/sync/sync.service.ts:26-80` (include `themeId` in snapshot)

**Interfaces:**
- Consumes: `Brand.themeId` (Task 2), `getTheme` (Task 1).
- Produces: `OutletDto.themeId: string`, `OutletDto.brandId: string`, `SyncSnapshotDto.themeId: string`.

- [ ] **Step 1: Extend the shared DTOs**

In `packages/shared/src/types.ts`, update `OutletDto` (around line 142) and `SyncSnapshotDto` (around line 729):

```ts
export interface OutletDto {
  id: string;
  name: string;
  brandName: string;
  brandId: string;
  themeId: string;
  address: string | null;
}

export interface SyncSnapshotDto {
  menu: MenuCategoryDto[];
  areas: AreaDto[];
  themeId: string;
  serverTime: string;
}
```

Then rebuild shared: `pnpm --filter @stello/shared build`

- [ ] **Step 2: Populate themeId/brandId where OutletDto is built**

In `apps/api/src/outlets/outlets.controller.ts`, find the query that loads outlets and the object(s) mapped to `OutletDto`. Ensure the Prisma query includes the brand, e.g. `include: { brand: true }` (or select `brand: { select: { id: true, name: true, themeId: true } }`), and set the new fields on each returned outlet:

```ts
// for each outlet `o` with its brand loaded:
{
  id: o.id,
  name: o.name,
  brandName: o.brand.name,
  brandId: o.brandId,
  themeId: o.brand.themeId,
  address: o.address,
}
```

- [ ] **Step 3: Include themeId in the sync snapshot**

In `apps/api/src/sync/sync.service.ts`, inside `snapshot(...)`, load the outlet's brand theme and add it to the returned object. Before the `return { menu, areas: areaDtos, serverTime: ... }`, add a lookup:

```ts
const outlet = await this.prisma.outlet.findUniqueOrThrow({
  where: { id: outletId },
  select: { brand: { select: { themeId: true } } },
});
return {
  menu,
  areas: areaDtos,
  themeId: outlet.brand.themeId,
  serverTime: new Date().toISOString(),
};
```

- [ ] **Step 4: Typecheck the API**

Run: `pnpm --filter @stello/api exec tsc --noEmit -p tsconfig.json`
Expected: exit 0 (no errors — every `OutletDto`/`SyncSnapshotDto` construction now compiles with the new required fields).

- [ ] **Step 5: Verify at runtime**

Start the API (`pnpm dev:api`), then:

```bash
TOKEN=$(curl -s localhost:3001/api/v1/auth/login -H "content-type: application/json" \
  -d '{"email":"admin@demo.com","password":"password123"}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).accessToken))")
curl -s localhost:3001/api/v1/outlets -H "authorization: Bearer $TOKEN"
```

Expected: each outlet object includes `"themeId":"counter"` and `"brandId":"..."`.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types.ts apps/api/src/outlets/outlets.controller.ts apps/api/src/sync/sync.service.ts
git commit -m "feat(api): expose brand themeId on OutletDto and sync snapshot"
```

---

### Task 4: `PATCH /brands/:id/theme` (owner-only, validated)

**Files:**
- Create: `apps/api/src/brands/brands.service.ts`
- Create: `apps/api/src/brands/brands.controller.ts`
- Create: `apps/api/src/brands/brands.module.ts`
- Modify: `apps/api/src/app.module.ts` (register `BrandsModule`)

**Interfaces:**
- Consumes: `UpdateBrandThemeSchema`, `isThemeId` (Task 1); `RequirePermission`, `CurrentUser` (`apps/api/src/common/decorators.ts`); `AuthUser`.
- Produces: `PATCH /brands/:id/theme` → `{ id: string; themeId: string }`.

- [ ] **Step 1: Write the service**

Create `apps/api/src/brands/brands.service.ts`:

```ts
import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthUser } from "@stello/shared";
import { isThemeId } from "@stello/shared";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class BrandsService {
  constructor(private prisma: PrismaService) {}

  async setTheme(user: AuthUser, brandId: string, themeId: string) {
    if (!isThemeId(themeId)) throw new ForbiddenException("Unknown theme");
    const brand = await this.prisma.brand.findUnique({ where: { id: brandId } });
    if (!brand || brand.tenantId !== user.tenantId) throw new NotFoundException("Brand not found");
    const updated = await this.prisma.brand.update({
      where: { id: brandId },
      data: { themeId },
    });
    return { id: updated.id, themeId: updated.themeId };
  }
}
```

(Confirm the Prisma service import path matches other modules — check `apps/api/src/devices/devices.service.ts` for the exact `PrismaService` import.)

- [ ] **Step 2: Write the controller**

Create `apps/api/src/brands/brands.controller.ts`:

```ts
import { Body, Controller, Param, Patch } from "@nestjs/common";
import type { AuthUser } from "@stello/shared";
import { UpdateBrandThemeSchema } from "@stello/shared";
import { CurrentUser, RequirePermission } from "../common/decorators";
import { BrandsService } from "./brands.service";

@Controller("brands/:id")
export class BrandsController {
  constructor(private brands: BrandsService) {}

  @Patch("theme")
  @RequirePermission("settings.manage")
  setTheme(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { themeId } = UpdateBrandThemeSchema.parse(body);
    return this.brands.setTheme(user, id, themeId);
  }
}
```

- [ ] **Step 3: Write the module and register it**

Create `apps/api/src/brands/brands.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { BrandsController } from "./brands.controller";
import { BrandsService } from "./brands.service";

@Module({ imports: [PrismaModule], controllers: [BrandsController], providers: [BrandsService] })
export class BrandsModule {}
```

(Check `apps/api/src/devices/devices.module.ts` for the exact `PrismaModule` import path; if modules import Prisma differently, mirror that.)

Add `BrandsModule` to the `imports` array in `apps/api/src/app.module.ts`.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @stello/api exec tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 5: Verify authz and validation at runtime**

With the API running and `$TOKEN` from an owner login (Task 3 Step 5), and a `$BRAND` id from the outlets response:

```bash
# happy path
curl -s -X PATCH localhost:3001/api/v1/brands/$BRAND/theme -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" -d '{"themeId":"line"}'
# -> {"id":"...","themeId":"line"}

# unknown theme -> 400/403
curl -s -o /dev/null -w "%{http_code}\n" -X PATCH localhost:3001/api/v1/brands/$BRAND/theme \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{"themeId":"bogus"}'

# cashier token (cashier@demo.com) -> 403
CTOKEN=$(curl -s localhost:3001/api/v1/auth/login -H "content-type: application/json" \
  -d '{"email":"cashier@demo.com","password":"password123"}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).accessToken))")
curl -s -o /dev/null -w "%{http_code}\n" -X PATCH localhost:3001/api/v1/brands/$BRAND/theme \
  -H "authorization: Bearer $CTOKEN" -H "content-type: application/json" -d '{"themeId":"line"}'
```

Expected: happy path returns the object; bogus theme is 4xx; cashier is 403. Reset to counter: `-d '{"themeId":"counter"}'`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/brands apps/api/src/app.module.ts
git commit -m "feat(api): PATCH /brands/:id/theme (settings.manage, validated)"
```

---

### Task 5: React ThemeProvider in the POS

**Files:**
- Create: `apps/pos/src/ThemeProvider.tsx`
- Modify: `apps/pos/src/App.tsx` (apply the selected outlet's theme)

**Interfaces:**
- Consumes: `applyTheme`, `getTheme`, `DEFAULT_THEME_ID` (Task 1); `OutletDto.themeId` (Task 3).
- Produces: `<ThemeProvider themeId={...}>` that applies tokens to `document.documentElement`.

- [ ] **Step 1: Create the provider**

Create `apps/pos/src/ThemeProvider.tsx`:

```tsx
import { useEffect } from "react";
import { applyTheme, getTheme, DEFAULT_THEME_ID } from "@stello/shared";

export function ThemeProvider({ themeId, children }: { themeId?: string; children: React.ReactNode }) {
  useEffect(() => {
    applyTheme(getTheme(themeId ?? DEFAULT_THEME_ID), document.documentElement);
  }, [themeId]);
  return <>{children}</>;
}
```

- [ ] **Step 2: Wire it into App**

In `apps/pos/src/App.tsx`, wrap the rendered tree so the selected outlet's theme applies. Import the provider and use `outlet?.themeId`:

```tsx
import { ThemeProvider } from "./ThemeProvider";
// ...in the component's return, wrap the top-level element:
return (
  <ThemeProvider themeId={outlet?.themeId}>
    {/* existing App JSX unchanged */}
  </ThemeProvider>
);
```

(The `outlet` state already exists in `App.tsx`. Before an outlet is chosen, `themeId` is undefined and the default theme applies.)

- [ ] **Step 3: Verify it applies**

Run the POS (`pnpm dev:pos`), sign in as `admin@demo.com`, pick an outlet. In devtools, inspect `<html>`: it has `data-theme="counter"` and `--accent` set. Then change the brand theme via the API (Task 4 Step 5, e.g. to `line`), reload the POS, pick the outlet again → `<html data-theme="line">`.

- [ ] **Step 4: Commit**

```bash
git add apps/pos/src/ThemeProvider.tsx apps/pos/src/App.tsx
git commit -m "feat(pos): apply the outlet's brand theme via ThemeProvider"
```

---

### Task 6: POS consumes the token contract (Tailwind + CSS variables)

**Files:**
- Create: `tailwind.preset.cjs` (repo root — shared token→utility mapping)
- Create: `apps/pos/tailwind.config.cjs`
- Create: `apps/pos/postcss.config.cjs`
- Modify: `apps/pos/src/styles.css` (declare token defaults; replace hardcoded colours with `var(--token)`)
- Modify: `apps/pos/package.json` (add tailwindcss, postcss, autoprefixer, lucide-react, framer-motion)

**Interfaces:**
- Consumes: the CSS variables written by `applyTheme` (Task 5) and the token names from `REQUIRED_TOKENS` (Task 1).
- Produces: a POS that renders entirely from tokens (so all 11 themes work) and a reusable `tailwind.preset.cjs` Phase 2 apps import.

- [ ] **Step 1: Install styling dependencies**

Run: `pnpm --filter @stello/pos add -D tailwindcss@^3.4.0 postcss autoprefixer` and `pnpm --filter @stello/pos add lucide-react framer-motion`
Expected: added without peer-dep errors.

- [ ] **Step 2: Create the shared Tailwind preset**

Create `tailwind.preset.cjs` at the repo root:

```js
/** Maps design tokens (CSS variables) to Tailwind utilities. Imported by every app config. */
module.exports = {
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)", panel: "var(--panel)", "panel-2": "var(--panel-2)", card: "var(--card-bg)",
        ink: "var(--ink)", muted: "var(--muted)", faint: "var(--faint)", line: "var(--line)",
        accent: "var(--accent)", "accent-ink": "var(--accent-ink)", "accent-soft": "var(--accent-soft)",
        veg: "var(--veg)", nonveg: "var(--nonveg)", good: "var(--good)", warn: "var(--warn)", crit: "var(--crit)",
      },
      borderRadius: { DEFAULT: "var(--radius)", sm: "var(--radius-sm)" },
      fontFamily: { display: "var(--font-display)", body: "var(--font-body)", num: "var(--font-num)" },
      boxShadow: { card: "var(--shadow)" },
    },
  },
};
```

- [ ] **Step 2b: Create the POS Tailwind + PostCSS config**

Create `apps/pos/tailwind.config.cjs`:

```js
module.exports = {
  presets: [require("../../tailwind.preset.cjs")],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
};
```

Create `apps/pos/postcss.config.cjs`:

```js
module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

- [ ] **Step 3: Declare token defaults at the top of the stylesheet**

At the very top of `apps/pos/src/styles.css`, add the Tailwind layers and a `:root` fallback set (so the app is styled even before `applyTheme` runs — values equal the `counter` default). This guarantees no unstyled flash:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --bg:#f8fafc; --panel:#ffffff; --panel-2:#f1f5f9; --card-bg:#ffffff;
  --ink:#0f172a; --muted:#64748b; --faint:#94a3b8; --line:#e2e8f0;
  --accent:#6366f1; --accent-ink:#ffffff; --accent-soft:#e6e7fd;
  --veg:#16a34a; --nonveg:#dc2626; --good:#2f7d47; --warn:#c07a09; --crit:#b23a32;
  --radius:14px; --radius-sm:9px; --gap:12px; --shadow:0 10px 26px rgba(15,23,42,.06);
  --font-display:ui-sans-serif,system-ui,sans-serif; --font-body:ui-sans-serif,system-ui,sans-serif;
  --font-num:ui-sans-serif,system-ui,sans-serif; --label-tt:none; --label-ls:0;
}
```

- [ ] **Step 4: Replace hardcoded colours with tokens**

Go through `apps/pos/src/styles.css` and replace hardcoded design values with the tokens (this is the pilot redesign). Rules:
- Page/background fills → `var(--bg)`; panels/rails → `var(--panel)` / `var(--panel-2)`; cards → `var(--card-bg)`.
- Primary text → `var(--ink)`; secondary → `var(--muted)`; tertiary → `var(--faint)`.
- Borders/dividers → `var(--line)`.
- Primary buttons / active accents / brand marks → `var(--accent)` with text `var(--accent-ink)`; tints → `var(--accent-soft)`.
- Veg dot → `var(--veg)`; non-veg dot → `var(--nonveg)`; success/warn/danger → `var(--good)`/`var(--warn)`/`var(--crit)`.
- Corner radii → `var(--radius)` / `var(--radius-sm)`; card shadow → `var(--shadow)`.
- Money/number columns → `font-family: var(--font-num)` + `font-variant-numeric: tabular-nums`; wordmark/headers → `var(--font-display)`.
- Uppercase micro-labels → `text-transform: var(--label-tt); letter-spacing: var(--label-ls);`.

Do not change layout, class names, or markup — only the values. Work top-to-bottom; keep a grep check that no raw hex remains for themed surfaces:

Run: `grep -nE "#[0-9a-fA-F]{3,6}" apps/pos/src/styles.css`
Expected: only the `:root` default block from Step 3 (and any intentionally non-themed values) still contain hex.

- [ ] **Step 5: Build the POS**

Run: `pnpm --filter @stello/pos build`
Expected: `tsc -b && vite build` succeeds; Tailwind compiles.

- [ ] **Step 6: Verify all themes render (verify skill)**

Run `pnpm dev:pos`, sign in, pick the outlet. Using the API (Task 4), set the brand theme to `line`, `thali`, `console`, and `aurora` in turn, reloading the POS each time. Confirm each renders coherently — accent, surfaces, radius, fonts, and money all shift; veg/non-veg dots stay legible; no unstyled elements.

- [ ] **Step 7: Commit**

```bash
git add tailwind.preset.cjs apps/pos/tailwind.config.cjs apps/pos/postcss.config.cjs apps/pos/src/styles.css apps/pos/package.json pnpm-lock.yaml
git commit -m "feat(pos): render from design tokens via Tailwind preset (theme pilot)"
```

---

### Task 7: Settings → Appearance picker in the Console

**Files:**
- Create: `apps/dashboard/components/AppearanceTab.tsx`
- Modify: `apps/dashboard/components/Console.tsx` (add `settings` tab + nav entry + render)
- Modify: `apps/dashboard/lib/api.ts` (add `setBrandTheme`)

**Interfaces:**
- Consumes: `THEMES`, `Theme`, `applyTheme`, `getTheme` (Task 1); `OutletDto.brandId` / `OutletDto.themeId` (Task 3); `PATCH /brands/:id/theme` (Task 4).
- Produces: an owner-facing theme gallery that persists the brand theme.

- [ ] **Step 1: Add the API client method**

In `apps/dashboard/lib/api.ts`, add (matching the file's existing fetch-wrapper style — check how other mutating calls like device update are written and mirror the request helper):

```ts
async setBrandTheme(brandId: string, themeId: string): Promise<{ id: string; themeId: string }> {
  return request(`/brands/${brandId}/theme`, { method: "PATCH", body: JSON.stringify({ themeId }) });
},
```

(Use the same request helper / auth header pattern already present in `lib/api.ts`; do not invent a new fetch wrapper.)

- [ ] **Step 2: Build the AppearanceTab**

Create `apps/dashboard/components/AppearanceTab.tsx`:

```tsx
import { useState } from "react";
import type { OutletDto } from "@stello/shared";
import { THEMES } from "@stello/shared";
import { api } from "../lib/api";

export function AppearanceTab({ outlet }: { outlet: OutletDto }) {
  const [selected, setSelected] = useState(outlet.themeId);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const current = THEMES.find((t) => t.id === selected) ?? THEMES[0];

  const save = async () => {
    setSaving(true);
    try {
      await api.setBrandTheme(outlet.brandId, selected);
      setSaved(selected);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="appearance">
      <h2>Appearance</h2>
      <p className="muted">
        Choose the theme for <b>{outlet.brandName}</b>. Applies brand-wide across POS, KDS,
        Console, Scan &amp; Order, and Edge.
      </p>
      <div className="theme-grid">
        {THEMES.map((t) => (
          <button
            key={t.id}
            className={`theme-card${t.id === selected ? " sel" : ""}`}
            onClick={() => setSelected(t.id)}
            aria-pressed={t.id === selected}
          >
            <span className="theme-prev" style={{ background: t.tokens["--bg"], color: t.tokens["--ink"] }}>
              <span className="tw" style={{ color: t.tokens["--accent"] }}>STELLO KITCHENS</span>
              <span className="tbtn" style={{ background: t.tokens["--accent"], color: t.tokens["--accent-ink"] }}>
                Send KOT
              </span>
            </span>
            <span className="theme-meta">
              <b>{t.name}</b>
              <span className={`mode ${t.mode}`}>{t.mode}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="appearance-actions">
        <span className="muted">Selected: <b>{current.name}</b></span>
        <button className="btn-primary" onClick={save} disabled={saving || saved === selected}>
          {saving ? "Saving…" : saved === selected ? "Saved" : "Save changes"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Register the tab in Console**

In `apps/dashboard/components/Console.tsx`:
- add `"settings"` to the `Tab` union (line ~28);
- import `AppearanceTab`;
- add a nav button for **Settings** alongside the others (mirror an existing nav entry's markup);
- render `{tab === "settings" && <AppearanceTab outlet={outlet} />}` where the other tabs render.

- [ ] **Step 4: Add minimal styles**

Append to `apps/dashboard/app/globals.css` styles for `.theme-grid` (responsive grid), `.theme-card` (bordered, `.sel` gets an accent ring), `.theme-prev` (74px preview padding), `.theme-meta`, `.mode.dark`, and `.appearance-actions`. Use the Console's existing spacing/border variables so it matches the console chrome.

- [ ] **Step 5: Verify end-to-end**

Run `pnpm dev:api`, `pnpm dev:dashboard`, `pnpm dev:pos`. As `admin@demo.com` open the Console → **Settings** → pick **Ember** → Save. Reload the POS, pick the outlet → it renders in Ember. Sign into the Console as `cashier@demo.com`: the Save call returns 403 (the Settings tab may be shown, but saving is blocked server-side).

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/components/AppearanceTab.tsx apps/dashboard/components/Console.tsx apps/dashboard/lib/api.ts apps/dashboard/app/globals.css
git commit -m "feat(dashboard): Settings -> Appearance theme picker (per brand)"
```

---

## Phase 1 Definition of Done

- `pnpm --filter @stello/shared test` passes (registry completeness, fallback, contrast, applyTheme).
- Owner changes the theme in Console → Settings → Appearance; it persists (`Brand.themeId`).
- The POS renders in the selected theme (all 11 verified to render coherently) and picks it up from the outlet payload; the default `counter` applies before selection.
- A cashier is blocked (403) from changing the theme.
- `OutletDto` and `SyncSnapshotDto` carry `themeId`; the API typechecks clean.

## Phase 2 (separate plans — not in this plan)

Roll the token-contract refactor through **KDS → Console (self-theming, with SSR no-FOUC in `app/layout.tsx`) → Scan & Order → Edge (reads `themeId` from `/sync/snapshot`)**, then polish all 11 themes across every screen. Each app is its own plan following the pattern proven on the POS here.
