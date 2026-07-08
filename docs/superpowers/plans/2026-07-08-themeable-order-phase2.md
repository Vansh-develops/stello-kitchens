# Themeable Scan & Order — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the diner-facing Scan & Order PWA (`apps/order`) follow the brand's selected theme, so a guest's table menu, kiosk, and the token-display board all render in the brand's chosen look.

**Architecture:** Diners never authenticate or pick an outlet — every surface is keyed by an opaque public token. So the theme must ride along on the **public scan API responses**: add `themeId` (from the outlet's `brand.themeId`) to the menu and board DTOs the diner app fetches. The app then applies it via the same client `ThemeProvider` pattern used by POS/KDS/Console, and its `styles.css` is remapped onto the shared design tokens.

**Tech Stack:** React + Vite (PWA), NestJS + Prisma (the public scan endpoints), TypeScript, `@stello/shared`.

## Global Constraints

- **Base branch:** Phase 1, KDS, and Console are all merged to `main`, so branch this off `main` (the shared registry, `Brand.themeId`, and `tailwind.preset.cjs` are present).
- Scope: `apps/order/**`, plus a small change to the API's public scan module and the shared DTOs. Do NOT modify the theme registry, other apps, or the root `tailwind.preset.cjs`.
- Token names are those in `REQUIRED_TOKENS` (`packages/shared/src/theme.ts`). The `:root` shared-token defaults equal the `counter` theme (identical block used by POS/KDS/Console).
- The diner endpoints are all `@Public` (no auth) and keyed by opaque token — do NOT add auth or leak tenant/outlet ids; only add the non-sensitive `themeId` string.
- **`--ink` collision:** like the Console, the order app defines `--ink` (`#14110f`) and uses it as a **background**; the shared `--ink` token is **text**. Background usages of `var(--ink)` must move to `var(--bg)`. The order app uses `--text` for text and **defines** `--ink-2`/`--ink-3` (surface shades) — remap those to `--panel`/`--panel-2`.
- `ThemeProvider` mirrors the KDS/Console provider (React client component). No Tailwind is needed for `apps/order` unless it uses utility classes (it does not — theming is variable-only), so do not add Tailwind; the shared preset is not used here.
- Verify with `pnpm --filter @stello/order build` + a hardcoded-hex grep gate + a Playwright multi-theme render check.

## Palette remap (order app)

| order var | current | → shared token | notes |
| --- | --- | --- | --- |
| `--ink` | `#14110f` (background) | `--bg` | migrate `var(--ink)` background usages → `var(--bg)`; remove `--ink` def (collides with shared text token). |
| `--ink-2` | `#1d1916` | `--panel` | defined here; redefine as alias. |
| `--ink-3` | `#272119` | `--panel-2` | defined here; redefine as alias. |
| `--text` | `#f4ede2` | `--ink` | diner text → shared ink. |
| `--saffron` | `#f5a623` | `--accent` | primary accent. |
| `--saffron-soft` | `#f8c46a` | `--accent-soft` | accent tint. |
| `--mint` | `#2dd4a7` | `--good` | positive accent. |
| `--chili` | `#e2542a` | `--crit` | danger. |
| `--line` | `#372f26` | `--line` | same name — theme-driven; keep only as counter default. |
| `--muted`, `--dim` | | `--muted`, `--faint` | same/near names. |
| `--font`, `--mono` | fonts | (unchanged) | keep the diner type identity. |

---

### Task 1: Expose `themeId` on the public scan DTOs (API)

**Files:**
- Modify: `packages/shared/src/types.ts` (`PublicMenuDto`, `TokenBoardDto`)
- Modify: `apps/api/src/scan-order/scan-order.service.ts` (`menuForTable`, `menuForOutlet`, `board`)

**Interfaces:**
- Consumes: `Brand.themeId` (Phase 1).
- Produces: `PublicMenuDto.themeId: string`, `TokenBoardDto.themeId: string`.

- [ ] **Step 1: Add `themeId` to the shared DTOs**

In `packages/shared/src/types.ts`, add `themeId: string;` to both `PublicMenuDto` and `TokenBoardDto` (keep the existing fields). Then rebuild shared: `pnpm --filter @stello/shared build`.

- [ ] **Step 2: Populate it in the service (load the brand)**

In `apps/api/src/scan-order/scan-order.service.ts`:
- `menuForTable` already does `include: { outlet: true }` — change it to load the brand too: `include: { outlet: { include: { brand: true } } }`, and add `themeId: table.outlet.brand.themeId` to the returned object.
- `menuForOutlet` loads the outlet via `findUnique({ where: { publicToken: token } })` — add `include: { brand: true }` and set `themeId: outlet.brand.themeId` on the returned object.
- `board` loads the outlet the same way — add `include: { brand: true }` and set `themeId: outlet.brand.themeId` on the returned object.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @stello/api exec tsc --noEmit -p tsconfig.json`
Expected: exit 0 (every `PublicMenuDto`/`TokenBoardDto` construction now sets the new required field).

- [ ] **Step 4: Verify at runtime**

With Docker Postgres up and the API running (on an alternate port if 3001 is occupied; do NOT touch a process you didn't start), get the seeded outlet's public token and hit the kiosk menu + board:

```bash
TOKEN=$(docker exec stello-postgres psql -U stello -d stello -t -A -c "select \"publicToken\" from outlets where \"publicToken\" is not null limit 1;")
curl -s "localhost:3001/api/v1/public/scan/kiosk/$TOKEN" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log('kiosk themeId:', j.themeId)})"
curl -s "localhost:3001/api/v1/public/scan/board/$TOKEN" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log('board themeId:', j.themeId)})"
```

Expected: both print `themeId: counter`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts apps/api/src/scan-order/scan-order.service.ts
git commit -m "feat(api): expose brand themeId on public scan menu + board DTOs"
```

---

### Task 2: Order ThemeProvider + wiring + Vite interop

**Files:**
- Create: `apps/order/src/ThemeProvider.tsx`
- Modify: `apps/order/src/App.tsx` (landing default)
- Modify: `apps/order/src/Menu.tsx` (apply fetched theme)
- Modify: `apps/order/src/Board.tsx` (apply fetched theme)
- Modify: `apps/order/vite.config.ts` (CJS-interop + optimizeDeps)

**Interfaces:**
- Consumes: `applyTheme`, `getTheme`, `DEFAULT_THEME_ID` (`@stello/shared`); `PublicMenuDto.themeId` / `TokenBoardDto.themeId` (Task 1).
- Produces: `<ThemeProvider themeId={...}>` applying tokens to `document.documentElement`.

- [ ] **Step 1: Create the provider**

Create `apps/order/src/ThemeProvider.tsx` (identical to the KDS/Console provider):

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

- [ ] **Step 2: Apply the fetched theme in Menu and Board; default on the landing**

The diner app is route-based: `App.tsx` renders `<Menu>` (for `/t/:token` and `/kiosk/:token`), `<Board>` (for `/board/:token`), or a landing page. `Menu` and `Board` each fetch their data by token (`PublicMenuDto` / `TokenBoardDto`, which now carry `themeId`). Apply the theme where the data lives:
- In `apps/order/src/Menu.tsx`: wrap the component's rendered tree in `<ThemeProvider themeId={menu?.themeId}>` (use whatever the fetched-menu state variable is named; before it loads, `themeId` is undefined → default `counter`).
- In `apps/order/src/Board.tsx`: wrap the rendered tree in `<ThemeProvider themeId={board?.themeId}>` similarly.
- In `apps/order/src/App.tsx`: wrap the landing (no-token) return in a bare `<ThemeProvider>` (default `counter`), and import the provider. The Menu/Board branches get their theme from within those components, so wrapping them again in App is unnecessary — but importing and wrapping the landing keeps the default applied on the entry screen.

Do not change any other logic or markup.

- [ ] **Step 3: Vite CJS-interop + dev-server optimizeDeps**

`@stello/shared` is a pnpm-symlinked CommonJS package; the first runtime import needs Rollup's commonjs interop widened (production build) and Vite's dep optimizer to expose named exports (dev server). Read `apps/order/vite.config.ts`, then add both while preserving the existing `plugins: [react()]` and `server` block (with any existing proxies):

```ts
export default defineConfig({
  plugins: [react()],
  build: { commonjsOptions: { include: [/node_modules/, /packages\/shared/] } },
  optimizeDeps: { include: ["@stello/shared"] },
  server: { /* ...keep existing... */ },
});
```

- [ ] **Step 4: Build**

Run: `pnpm --filter @stello/order build`
Expected: `tsc` + `vite build` succeed. (If it can't resolve `applyTheme` from `@stello/shared`, run `pnpm --filter @stello/shared build` first, then rebuild.)

- [ ] **Step 5: Commit**

```bash
git add apps/order/src/ThemeProvider.tsx apps/order/src/App.tsx apps/order/src/Menu.tsx apps/order/src/Board.tsx apps/order/vite.config.ts
git commit -m "feat(order): apply the brand theme from the public scan response"
```

---

### Task 3: Remap order styles.css onto tokens + verify all themes

**Files:**
- Modify: `apps/order/src/styles.css`

**Interfaces:**
- Consumes: the CSS variables written by the `ThemeProvider` (Task 2); `REQUIRED_TOKENS`.
- Produces: an order app that renders coherently in every theme.

- [ ] **Step 1: Replace the `:root` palette with shared-token defaults + aliases**

At the top of `apps/order/src/styles.css`, replace the current `:root { --saffron … --mono }` block with (a) the shared-token counter defaults and (b) the order palette redefined as aliases per the mapping table (keep `--font`/`--mono`):

```css
:root {
  --bg:#f8fafc; --panel:#ffffff; --panel-2:#f1f5f9; --card-bg:#ffffff;
  --ink:#0f172a; --muted:#64748b; --faint:#94a3b8; --line:#e2e8f0;
  --accent:#6366f1; --accent-ink:#ffffff; --accent-soft:#e6e7fd;
  --veg:#16a34a; --nonveg:#dc2626; --good:#2f7d47; --warn:#c07a09; --crit:#b23a32;
  --radius:14px; --radius-sm:9px; --gap:12px; --shadow:0 10px 26px rgba(15,23,42,.06);
  --font-display:ui-sans-serif,system-ui,sans-serif; --font-body:ui-sans-serif,system-ui,sans-serif;
  --font-num:ui-sans-serif,system-ui,sans-serif; --label-tt:none; --label-ls:0;

  --saffron: var(--accent);
  --saffron-soft: var(--accent-soft);
  --ink-2: var(--panel);
  --ink-3: var(--panel-2);
  --text: var(--ink);
  --mint: var(--good);
  --chili: var(--crit);
  --dim: var(--faint);

  --font: "Space Grotesk", system-ui, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, monospace;
}
```

Note: do NOT re-alias `--line`/`--muted` — they are shared token names driven by `applyTheme` (the defaults above cover the pre-paint). Remove the old `--ink` definition (it collided with the shared text token).

- [ ] **Step 2: Migrate `var(--ink)` background usages to `var(--bg)`**

Run `grep -n "var(--ink)" apps/order/src/styles.css` (and check for the fallback form `grep -n "var(--ink," apps/order/src/styles.css`). For each usage: if it's a background/fill → `var(--bg)`; if it's a text colour → leave as `var(--ink)`. After this, there must be zero background usages of `var(--ink)` (the diner text comes through `--text` → `--ink`). List any left-as-text in your report.

- [ ] **Step 3: Tokenize any remaining hardcoded hex**

`styles.css` has ~16 raw hex values. Replace hardcoded design colours with tokens/aliases per the same mapping rules the earlier apps used (surfaces→bg/panel/panel-2; text→ink/muted/faint; borders→line; accent→accent/accent-soft; radii→radius/radius-sm; keep `999px` pills and `50%` circles). Leave genuinely non-themed values (pure-black scrims) and itemize them.

Run: `grep -nE "#[0-9a-fA-F]{3,6}" apps/order/src/styles.css`
Expected: only the `:root` default block (+ itemized non-themed values).

- [ ] **Step 4: Build**

Run: `pnpm --filter @stello/order build`
Expected: succeeds.

- [ ] **Step 5: Verify all themes render (verify skill)**

With the API up and Docker Postgres running, run `pnpm --filter @stello/order dev` (alternate ports; do NOT touch port 3001). Get a seeded table token (`select "publicToken" from restaurant_tables where "publicToken" is not null limit 1;`) or the outlet token for kiosk/board, and open `/t/<token>` (and `/kiosk/<token>`, `/board/<token>`). Using Settings → Appearance (or the API), switch the brand theme to `counter`, `line`, `thali`, and `noir`, reloading each time, and confirm the menu, cart, category chips, veg/non-veg dots, and the board re-theme coherently and stay legible on light and dark grounds. Use Playwright to load and screenshot if available. Reset to `counter` when done.

- [ ] **Step 6: Commit**

```bash
git add apps/order/src/styles.css
git commit -m "feat(order): render the diner app from design tokens; fully themeable"
```

---

## Definition of Done

- `pnpm --filter @stello/order build` and `pnpm --filter @stello/api exec tsc --noEmit` both succeed.
- The public scan menu + board responses carry `themeId`; the diner app applies it (verified across ≥2 light and ≥2 dark themes on `/t`, `/kiosk`, `/board`).
- `grep` shows no `var(--ink)` background usages and no hardcoded design colours in `styles.css` outside the `:root` default block (+ itemized non-themed values).
- Scope stayed within `apps/order/**` + the shared DTOs + the scan-order service.

## Next Phase-2 app (separate plan)

Edge (`apps/edge`) — theme from `/sync/snapshot.themeId` (already added in Phase 1), applied by the offline renderer.
